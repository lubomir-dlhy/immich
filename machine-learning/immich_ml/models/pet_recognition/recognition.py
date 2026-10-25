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
    ModelGraph,
    ModelInput,
    ModelSession,
    ModelSource,
    ModelTask,
    ModelType,
    PetDetectionOutput,
    PetRecognitionOptions,
    PetRecognitionOutput,
    Shape,
)

ANIMAL_ID_MODEL = "AnimalID-CLIP-ViT-B-32"
ANIMAL_ID_PREPROCESS_CFG: dict[str, Any] = {
    "size": 224,
    "interpolation": "bicubic",
    "mean": [0.48145466, 0.4578275, 0.40821073],
    "std": [0.26862954, 0.26130258, 0.27577711],
}


class PetRecognizer(InferenceModel[PetRecognitionOptions]):
    depends = [(ModelType.DETECTION, ModelTask.PET_RECOGNITION)]
    identity = (ModelType.RECOGNITION, ModelTask.PET_RECOGNITION)
    sources = (ModelSource.ANIMAL_ID, ModelSource.OPENCLIP)

    def __init__(self, model_name: str, cache_dir: Path | str | None = None, **model_kwargs: Any) -> None:
        self.is_animal_id_model = model_name == ANIMAL_ID_MODEL
        if cache_dir is None:
            cache_dir = self._pet_cache_dir(model_name)
        super().__init__(model_name, cache_dir=cache_dir, **model_kwargs)

    def _pet_cache_dir(self, model_name: str) -> Path:
        # the animal-ID model keeps its unversioned pet-specific cache; the OpenCLIP fallback reuses Smart Search's
        if self.is_animal_id_model:
            return settings.cache_folder / ModelTask.PET_RECOGNITION.value / model_name
        cache_dir = settings.cache_folder / ModelTask.SEARCH.value / model_name
        return cache_dir if settings.legacy_models else cache_dir / settings.model_revision

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
            return ANIMAL_ID_PREPROCESS_CFG
        log.debug(f"Loading visual preprocessing config for pet model '{self.model_name}'")
        preprocess_cfg: dict[str, Any] = json.load(self.preprocess_cfg_path.open(encoding="utf-8"))
        return preprocess_cfg

    def _load(self) -> ModelSession:
        size: list[int] | int = self.preprocess_cfg["size"]
        self.size = size[0] if isinstance(size, list) else size
        self.resampling = get_pil_resampling(self.preprocess_cfg["interpolation"])
        self.mean = np.array(self.preprocess_cfg["mean"], dtype=np.float32)
        self.std = np.array(self.preprocess_cfg["std"], dtype=np.float32)
        return super()._load()

    def _predict(
        self,
        inputs: NDArray[np.uint8] | bytes | Image.Image,
        detections: PetDetectionOutput,
        options: PetRecognitionOptions,
    ) -> PetRecognitionOutput:
        if detections["boxes"].shape[0] == 0:
            return []

        image = decode_pil(inputs)
        session = self.session.for_shape(Shape(batch=1))
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
            embedding = np.asarray(session.run(None, self.transform(session, crop))[0][0], dtype=np.float32)
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

    def transform(self, session: ModelGraph, image: Image.Image) -> ModelInput:
        image = crop_pil(resize_pil(image, self.size), self.size)
        if session.normalizes_input:
            return {"image": np.asarray(image if image.mode == "RGB" else image.convert("RGB"))[None]}
        return {"image": np.expand_dims(normalize(to_numpy(image), self.mean, self.std).transpose(2, 0, 1), 0)}
