import hashlib
from typing import Any
from urllib.request import urlretrieve

import numpy as np
from numpy.typing import NDArray

from immich_ml.models.base import InferenceModel
from immich_ml.models.transforms import decode_cv2
from immich_ml.schemas import ModelSession, ModelTask, ModelType, PetDetectionOutput

MODEL_RELEASE_URL = "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0"
DFINE_RELEASE_URL = "https://huggingface.co/onnx-community/dfine_l_coco-ONNX/resolve/main/onnx/model.onnx"
MODEL_SHA256 = {
    "yolox_s": "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063",
    "yolox_m": "21ff6cfdeb53b013bac2249599e55f00bff3cfdfdab37ed7a4620818c1d15b3f",
    "yolox_x": "c892d7aaf1c4746d8a4d675bec669a4db4f434b4ee1efb654bc9b353379c7c55",
    "dfine_l_coco": "d678f3baebfb909d3a20f21d1d807544d0172ed47fa1ab88e7fcdec7e365b236",
}
PET_CLASSES = {15: "cat", 16: "dog"}


class PetDetector(InferenceModel):
    depends = []
    identity = (ModelType.DETECTION, ModelTask.PET_RECOGNITION)

    def __init__(self, model_name: str, min_score: float = 0.25, **model_kwargs: Any) -> None:
        self.min_score = model_kwargs.pop("minScore", min_score)
        self.manual_box: dict[str, int] | None = None
        self.manual_species: str | None = None
        super().__init__(model_name, **model_kwargs)

    def _download(self) -> None:
        expected_digest = MODEL_SHA256.get(self.model_name)
        if expected_digest is None:
            raise ValueError(f"Unsupported pet detection model: {self.model_name}")

        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.model_path.with_suffix(".download")
        url = DFINE_RELEASE_URL if self._is_dfine else f"{MODEL_RELEASE_URL}/{self.model_name}.onnx"
        urlretrieve(url, temporary_path)
        with temporary_path.open("rb") as model_file:
            digest = hashlib.file_digest(model_file, "sha256").hexdigest()
        if digest != expected_digest:
            temporary_path.unlink(missing_ok=True)
            raise ValueError(f"Pet detection model checksum mismatch: expected {expected_digest}, got {digest}")
        temporary_path.replace(self.model_path)

    def _load(self) -> ModelSession:
        return self._make_session(self.model_path)

    def _predict(self, inputs: NDArray[np.uint8] | bytes) -> PetDetectionOutput:
        image = decode_cv2(inputs)
        manual_species = self.manual_species
        if self.manual_box is not None and manual_species in PET_CLASSES.values():
            assert manual_species is not None
            source_width = max(1, self.manual_box["imageWidth"])
            source_height = max(1, self.manual_box["imageHeight"])
            scale_x = image.shape[1] / source_width
            scale_y = image.shape[0] / source_height
            x1 = np.clip(self.manual_box["x"] * scale_x, 0, image.shape[1] - 1)
            y1 = np.clip(self.manual_box["y"] * scale_y, 0, image.shape[0] - 1)
            x2 = np.clip((self.manual_box["x"] + self.manual_box["width"]) * scale_x, x1 + 1, image.shape[1])
            y2 = np.clip((self.manual_box["y"] + self.manual_box["height"]) * scale_y, y1 + 1, image.shape[0])
            return {
                "boxes": np.asarray([[x1, y1, x2, y2]], dtype=np.float32),
                "scores": np.asarray([1.0], dtype=np.float32),
                "species": [manual_species],
            }

        if self._is_dfine:
            return self._predict_dfine(image)

        tensor, ratio = self._letterbox(image)
        input_name = self.session.get_inputs()[0].name
        if input_name is None:
            raise ValueError("Pet detection model input has no name")
        predictions = self.session.run(None, {input_name: tensor})[0][0]
        predictions = self._decode(predictions)

        class_ids = predictions[:, 5:].argmax(axis=1)
        class_scores = predictions[:, 5:].max(axis=1)
        scores = predictions[:, 4] * class_scores
        mask = np.isin(class_ids, list(PET_CLASSES)) & (scores >= self.min_score)
        if not np.any(mask):
            return {
                "boxes": np.empty((0, 4), dtype=np.float32),
                "scores": np.empty((0,), dtype=np.float32),
                "species": [],
            }

        predictions = predictions[mask]
        class_ids = class_ids[mask]
        scores = scores[mask]
        centers, sizes = predictions[:, :2], predictions[:, 2:4]
        boxes = (np.concatenate((centers - sizes / 2, centers + sizes / 2), axis=1) / ratio).astype(np.float32)

        selected: list[int] = []
        for class_id in PET_CLASSES:
            indices = np.flatnonzero(class_ids == class_id)
            if indices.size:
                selected.extend(indices[self._nms(boxes[indices], scores[indices])].tolist())

        selected.sort(key=lambda index: float(scores[index]), reverse=True)
        # YOLOX can label the same animal as both a cat and a dog. Per-class NMS
        # cannot remove those duplicates, so apply a second, class-agnostic pass
        # with a slightly more permissive overlap threshold.
        if len(selected) > 1:
            cross_species = self._nms(boxes[selected], scores[selected], threshold=0.55)
            selected = [selected[index] for index in cross_species]

        height, width = image.shape[:2]
        selected_boxes = boxes[selected]
        selected_boxes[:, [0, 2]] = np.clip(selected_boxes[:, [0, 2]], 0, width)
        selected_boxes[:, [1, 3]] = np.clip(selected_boxes[:, [1, 3]], 0, height)
        return {
            "boxes": selected_boxes.round().astype(np.float32),
            "scores": scores[selected].astype(np.float32),
            "species": [PET_CLASSES[int(class_ids[index])] for index in selected],
        }

    def _predict_dfine(self, image: NDArray[np.uint8]) -> PetDetectionOutput:
        tensor = self._prepare_dfine(image)
        input_name = self.session.get_inputs()[0].name
        if input_name is None:
            raise ValueError("Pet detection model input has no name")

        raw_outputs = self.session.run(None, {input_name: tensor})
        outputs = {
            output.name: value
            for output, value in zip(self.session.get_outputs(), raw_outputs)
            if output.name is not None
        }
        logits = outputs.get("logits", raw_outputs[0])[0]
        predicted_boxes = outputs.get("pred_boxes", raw_outputs[1])[0]

        # This is the focal-loss post-processing used by RT-DETR/D-FINE:
        # sigmoid all query/class scores, retain the best N query/class pairs,
        # then convert normalized centre boxes to source-image coordinates.
        probabilities = self._sigmoid(logits)
        flat_probabilities = probabilities.reshape(-1)
        top_count = min(logits.shape[0], flat_probabilities.size)
        top_indices = np.argpartition(flat_probabilities, -top_count)[-top_count:]
        top_indices = top_indices[np.argsort(flat_probabilities[top_indices])[::-1]]
        class_ids = top_indices % logits.shape[1]
        query_ids = top_indices // logits.shape[1]
        scores = flat_probabilities[top_indices]
        mask = np.isin(class_ids, list(PET_CLASSES)) & (scores >= self.min_score)
        if not np.any(mask):
            return self._empty_result()

        class_ids = class_ids[mask]
        query_ids = query_ids[mask]
        scores = scores[mask]
        centers = predicted_boxes[query_ids, :2]
        sizes = predicted_boxes[query_ids, 2:]
        boxes = np.concatenate((centers - sizes / 2, centers + sizes / 2), axis=1).astype(np.float32)
        height, width = image.shape[:2]
        boxes *= np.asarray([width, height, width, height], dtype=np.float32)

        selected: list[int] = []
        for class_id in PET_CLASSES:
            indices = np.flatnonzero(class_ids == class_id)
            if indices.size:
                selected.extend(indices[self._nms(boxes[indices], scores[indices])].tolist())
        selected.sort(key=lambda index: float(scores[index]), reverse=True)
        if len(selected) > 1:
            selected = [selected[index] for index in self._nms(boxes[selected], scores[selected], threshold=0.55)]

        selected_boxes = boxes[selected]
        selected_boxes[:, [0, 2]] = np.clip(selected_boxes[:, [0, 2]], 0, width)
        selected_boxes[:, [1, 3]] = np.clip(selected_boxes[:, [1, 3]], 0, height)
        return {
            "boxes": selected_boxes.round().astype(np.float32),
            "scores": scores[selected].astype(np.float32),
            "species": [PET_CLASSES[int(class_ids[index])] for index in selected],
        }

    @staticmethod
    def _prepare_dfine(image: NDArray[np.uint8], size: int = 640) -> NDArray[np.float32]:
        import cv2

        resized = cv2.resize(image, (size, size), interpolation=cv2.INTER_CUBIC)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
        return (rgb.transpose(2, 0, 1).astype(np.float32)[None, ...] / 255.0).astype(np.float32)

    @staticmethod
    def _sigmoid(values: NDArray[np.float32]) -> NDArray[np.float32]:
        return np.asarray(1.0 / (1.0 + np.exp(-values)), dtype=np.float32)

    @staticmethod
    def _empty_result() -> PetDetectionOutput:
        return {
            "boxes": np.empty((0, 4), dtype=np.float32),
            "scores": np.empty((0,), dtype=np.float32),
            "species": [],
        }

    @property
    def _is_dfine(self) -> bool:
        return self.model_name == "dfine_l_coco"

    @staticmethod
    def _letterbox(image: NDArray[np.uint8], size: int = 640) -> tuple[NDArray[np.float32], float]:
        import cv2

        height, width = image.shape[:2]
        ratio = min(size / height, size / width)
        resized = cv2.resize(image, (int(width * ratio), int(height * ratio)))
        padded = np.full((size, size, 3), 114, dtype=np.uint8)
        padded[: resized.shape[0], : resized.shape[1]] = resized
        tensor = padded.transpose(2, 0, 1).astype(np.float32)[None, ...]
        return tensor, ratio

    @staticmethod
    def _decode(predictions: NDArray[np.float32], size: int = 640) -> NDArray[np.float32]:
        grids: list[NDArray[np.float32]] = []
        strides: list[NDArray[np.float32]] = []
        for stride in (8, 16, 32):
            height = width = size // stride
            y_grid, x_grid = np.meshgrid(np.arange(height), np.arange(width), indexing="ij")
            grid = np.stack((x_grid, y_grid), axis=2).reshape(1, -1, 2).astype(np.float32)
            grids.append(grid)
            strides.append(np.full((*grid.shape[:2], 1), stride, dtype=np.float32))
        grid = np.concatenate(grids, axis=1)[0]
        expanded_strides = np.concatenate(strides, axis=1)[0]
        decoded = predictions.copy()
        decoded[:, :2] = (decoded[:, :2] + grid) * expanded_strides
        decoded[:, 2:4] = np.exp(decoded[:, 2:4]) * expanded_strides
        return decoded

    @classmethod
    def _nms(
        cls, boxes: NDArray[np.float32], scores: NDArray[np.float32], threshold: float = 0.45
    ) -> NDArray[np.int64]:
        order = scores.argsort()[::-1]
        keep: list[int] = []
        while order.size:
            index = int(order[0])
            keep.append(index)
            if order.size == 1:
                break
            remaining = order[1:]
            order = remaining[cls._iou(boxes[index], boxes[remaining]) <= threshold]
        return np.asarray(keep, dtype=np.int64)

    @staticmethod
    def _iou(box: NDArray[np.float32], boxes: NDArray[np.float32]) -> NDArray[np.float32]:
        top_left = np.maximum(box[:2], boxes[:, :2])
        bottom_right = np.minimum(box[2:], boxes[:, 2:])
        intersection = np.maximum(0, bottom_right - top_left)
        intersection_area = intersection[:, 0] * intersection[:, 1]
        box_area = (box[2] - box[0]) * (box[3] - box[1])
        boxes_area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
        return intersection_area / np.maximum(box_area + boxes_area - intersection_area, 1e-9)

    def configure(self, **kwargs: Any) -> None:
        self.min_score = kwargs.pop("minScore", self.min_score)
        self.manual_box = kwargs.pop("manualBox", None)
        self.manual_species = kwargs.pop("manualSpecies", None)
