import json
from functools import cached_property
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from immich_ml.config import log, settings
from immich_ml.models.base import InferenceModel
from immich_ml.models.transforms import (
    crop_pil,
    decode_pil,
    get_pil_resampling,
    normalize,
    resize_pil,
    serialize_np_array,
    to_numpy,
)
from immich_ml.schemas import (
    ModelSession,
    ModelTask,
    ModelType,
    PetDetectionOutput,
    PetRecognitionOutput,
)


class PetRecognizer(InferenceModel):
    depends = [(ModelType.DETECTION, ModelTask.PET_RECOGNITION)]
    identity = (ModelType.RECOGNITION, ModelTask.PET_RECOGNITION)

    def __init__(self, model_name: str, **model_kwargs: Any) -> None:
        self.is_animal_id_model = model_name == "AnimalID-CLIP-ViT-B-32"
        # The original fallback reuses Smart Search's OpenCLIP artifact. The
        # animal-ID model has its own pet-specific cache and 512-D projection.
        cache_dir = (
            settings.cache_folder / ModelTask.PET_RECOGNITION.value / model_name
            if self.is_animal_id_model
            else settings.cache_folder / ModelTask.SEARCH.value / model_name
        )
        super().__init__(model_name, cache_dir=cache_dir, **model_kwargs)

    @property
    def model_dir(self) -> Path:
        model_type = ModelType.RECOGNITION if self.is_animal_id_model else ModelType.VISUAL
        return self.cache_dir / model_type.value

    @property
    def preprocess_cfg_path(self) -> Path:
        return self.model_dir / "preprocess_cfg.json"

    @cached_property
    def preprocess_cfg(self) -> dict[str, Any]:
        if self.is_animal_id_model:
            return {
                "size": 224,
                "interpolation": "bicubic",
                "mean": [0.48145466, 0.4578275, 0.40821073],
                "std": [0.26862954, 0.26130258, 0.27577711],
            }
        log.debug(f"Loading visual preprocessing config for pet model '{self.model_name}'")
        return json.load(self.preprocess_cfg_path.open())

    def _load(self) -> ModelSession:
        size: list[int] | int = self.preprocess_cfg["size"]
        self.size = size[0] if isinstance(size, list) else size
        self.resampling = get_pil_resampling(self.preprocess_cfg["interpolation"])
        self.mean = np.array(self.preprocess_cfg["mean"], dtype=np.float32)
        self.std = np.array(self.preprocess_cfg["std"], dtype=np.float32)
        return super()._load()

    def _predict(self, inputs: Image.Image | bytes, detections: PetDetectionOutput) -> PetRecognitionOutput:
        if detections["boxes"].shape[0] == 0:
            return []

        image = decode_pil(inputs).convert("RGB")
        output: PetRecognitionOutput = []
        for box, score, species in zip(detections["boxes"], detections["scores"], detections["species"], strict=True):
            x1, y1, x2, y2 = (int(value) for value in box)
            padding_x = int((x2 - x1) * 0.08)
            padding_y = int((y2 - y1) * 0.08)
            crop = image.crop(
                (
                    max(0, x1 - padding_x),
                    max(0, y1 - padding_y),
                    min(image.width, x2 + padding_x),
                    min(image.height, y2 + padding_y),
                )
            )
            embedding: NDArray[np.float32] = self.session.run(None, self._transform(crop))[0][0]
            norm = np.linalg.norm(embedding)
            if norm:
                embedding = embedding / norm
            output.append(
                {
                    "boundingBox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                    "embedding": serialize_np_array(embedding),
                    "score": float(score),
                    "species": species,
                }
            )
        return output

    def _transform(self, image: Image.Image) -> dict[str, NDArray[np.float32]]:
        image = resize_pil(image, self.size)
        image = crop_pil(image, self.size)
        image_np = to_numpy(image)
        image_np = normalize(image_np, self.mean, self.std)
        return {"image": np.expand_dims(image_np.transpose(2, 0, 1), 0)}
