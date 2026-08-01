#!/usr/bin/env python3
"""Export and benchmark named pet crops from an Immich library."""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import io
import json
import math
import os
import random
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageOps


MODEL_SPECS = {
    "avito-dinov2-small": (
        "AvitoTech/DINO-v2-small-for-animal-identification",
        "dinov2",
        "facebook/dinov2-small",
    ),
    "avito-zer0int-clip-l": (
        "AvitoTech/Zer0int-CLIP-L-for-animal-identification",
        "clip",
        "zer0int/CLIP-GmP-ViT-L-14",
    ),
    "avito-siglip2-base": (
        "AvitoTech/SigLIP2-Base-for-animal-identification",
        "siglip",
        "google/siglip2-base-patch16-224",
    ),
    "avito-siglip2-giant": (
        "AvitoTech/SigLIP2-giant",
        "siglip",
        "google/siglip2-giant-opt-patch16-384",
    ),
}

ZERO_SHOT_MODEL_SPECS = {
    "google-siglip2-base": ("google/siglip2-base-patch16-224", None),
    "avito-zer0int-clip-l": (None, "avito-zer0int-clip-l"),
    "avito-siglip2-base": (None, "avito-siglip2-base"),
    "avito-siglip2-giant": (None, "avito-siglip2-giant"),
}

OXFORD_SPECIES = {1: "cat", 2: "dog"}


@dataclass(frozen=True)
class Sample:
    sample_id: str
    pet_id: str
    pet_name: str
    species: str
    asset_id: str
    sighting_id: str
    track_id: str
    frame_timestamp_ms: int
    source_type: str
    crop_path: str
    detection_score: float
    include: bool = True


class ImmichClient:
    def __init__(
        self,
        url: str,
        api_key: str | None = None,
        access_token: str | None = None,
        verify: bool = True,
        host_header: str | None = None,
    ) -> None:
        import httpx

        self.base_url = url.rstrip("/") + "/api"
        headers = {"accept": "application/json"}
        if host_header:
            headers["host"] = host_header
        cookies = None
        if api_key:
            headers["x-api-key"] = api_key
        elif access_token:
            cookies = {"immich_access_token": access_token}
        else:
            raise ValueError("An API key or access token is required")
        self.client = httpx.Client(
            base_url=self.base_url,
            headers=headers,
            cookies=cookies,
            timeout=90,
            follow_redirects=True,
            verify=verify,
        )

    def get_json(self, path: str) -> Any:
        response = self.client.get(path)
        response.raise_for_status()
        return response.json()

    def post_json(self, path: str, payload: dict[str, Any]) -> Any:
        response = self.client.post(path, json=payload)
        response.raise_for_status()
        return response.json()

    def get_bytes(self, path: str, params: dict[str, Any] | None = None) -> bytes:
        response = self.client.get(path, params=params, headers={"accept": "image/*"})
        response.raise_for_status()
        return response.content


def deterministic_sample(items: Sequence[Any], limit: int, seed: str) -> list[Any]:
    if len(items) <= limit:
        return list(items)
    rng = random.Random(int(hashlib.sha256(seed.encode()).hexdigest()[:16], 16))
    indexes = sorted(rng.sample(range(len(items)), limit))
    return [items[index] for index in indexes]


def crop_sighting(frame: Image.Image, sighting: dict[str, Any], padding: float = 0.08) -> Image.Image:
    source_width = max(1, int(sighting["imageWidth"]))
    source_height = max(1, int(sighting["imageHeight"]))
    scale_x = frame.width / source_width
    scale_y = frame.height / source_height
    x1 = float(sighting["boundingBoxX1"])
    y1 = float(sighting["boundingBoxY1"])
    x2 = float(sighting["boundingBoxX2"])
    y2 = float(sighting["boundingBoxY2"])
    pad_x = (x2 - x1) * padding
    pad_y = (y2 - y1) * padding
    bounds = (
        max(0, round((x1 - pad_x) * scale_x)),
        max(0, round((y1 - pad_y) * scale_y)),
        min(frame.width, round((x2 + pad_x) * scale_x)),
        min(frame.height, round((y2 + pad_y) * scale_y)),
    )
    if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
        raise ValueError(f"Invalid scaled crop bounds: {bounds}")
    return frame.crop(bounds).convert("RGB")


def search_pet_assets(client: ImmichClient, pet_id: str) -> list[dict[str, Any]]:
    assets: list[dict[str, Any]] = []
    page = 1
    while True:
        result = client.post_json(
            "/search/metadata",
            {"petIds": [pet_id], "page": page, "size": 1000, "withExif": False},
        )
        page_items = result.get("assets", result).get("items", [])
        assets.extend(page_items)
        if not result.get("assets", result).get("nextPage"):
            return assets
        page += 1


def export_dataset(args: argparse.Namespace) -> None:
    api_key = args.api_key or os.environ.get("IMMICH_API_KEY")
    access_token = args.access_token or os.environ.get("IMMICH_ACCESS_TOKEN")
    if not api_key and not access_token:
        raise SystemExit("Set IMMICH_API_KEY/IMMICH_ACCESS_TOKEN or pass --api-key/--access-token")
    output = Path(args.output).resolve()
    crops_dir = output / "crops"
    crops_dir.mkdir(parents=True, exist_ok=True)
    client = ImmichClient(args.url, api_key=api_key, access_token=access_token)
    pets = client.get_json("/pets")
    if not args.include_unnamed:
        pets = [pet for pet in pets if pet.get("name", "").strip()]
    if args.species != "all":
        pets = [pet for pet in pets if pet.get("species") == args.species]
    print(f"Exporting {len(pets)} pet clusters", flush=True)

    samples: list[Sample] = []
    errors: list[dict[str, str]] = []
    for pet_index, pet in enumerate(sorted(pets, key=lambda value: value.get("name", "").casefold()), start=1):
        pet_name = pet.get("name", "").strip() or f"Unrecognized {pet['species']} {pet['id'][:8]}"
        assets = search_pet_assets(client, pet["id"])
        assets = deterministic_sample(assets, args.max_assets_per_pet, f"assets:{pet['id']}")
        candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for asset in assets:
            try:
                sightings = client.get_json(f"/pets/assets/{asset['id']}")
                matching = [
                    sighting
                    for sighting in sightings
                    if sighting.get("pet") and sighting["pet"].get("id") == pet["id"]
                ]
                matching = deterministic_sample(
                    sorted(matching, key=lambda value: (value.get("frameTimestampMs", 0), value["id"])),
                    args.max_samples_per_asset,
                    f"sightings:{pet['id']}:{asset['id']}",
                )
                candidates.extend((asset, sighting) for sighting in matching)
            except Exception as error:  # noqa: BLE001 - preserve the rest of a large export
                errors.append({"pet": pet_name, "assetId": asset["id"], "error": str(error)})

        candidates = deterministic_sample(candidates, args.max_samples_per_pet, f"samples:{pet['id']}")
        print(f"[{pet_index}/{len(pets)}] {pet_name}: {len(candidates)} crops", flush=True)
        for asset, sighting in candidates:
            sample_id = sighting["id"]
            relative_path = Path("crops") / pet["id"] / f"{sample_id}.jpg"
            destination = output / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            try:
                if not destination.exists():
                    if asset.get("type") == "VIDEO":
                        image_bytes = client.get_bytes(f"/pets/assets/{sighting['id']}/thumbnail")
                    else:
                        image_bytes = client.get_bytes(f"/assets/{asset['id']}/thumbnail", {"size": "preview"})
                    frame = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes))).convert("RGB")
                    crop = crop_sighting(frame, sighting)
                    crop.thumbnail((args.crop_size, args.crop_size), Image.Resampling.LANCZOS)
                    crop.save(destination, "JPEG", quality=92, optimize=True)
                samples.append(
                    Sample(
                        sample_id=sample_id,
                        pet_id=pet["id"],
                        pet_name=pet_name,
                        species=pet["species"],
                        asset_id=asset["id"],
                        sighting_id=sighting["id"],
                        track_id=sighting.get("trackId", sighting["id"]),
                        frame_timestamp_ms=int(sighting.get("frameTimestampMs", 0)),
                        source_type=asset.get("type", "IMAGE"),
                        crop_path=relative_path.as_posix(),
                        detection_score=float(sighting.get("detectionScore", 0)),
                    )
                )
            except Exception as error:  # noqa: BLE001
                errors.append({"pet": pet_name, "assetId": asset["id"], "error": str(error)})

    manifest = output / "manifest.jsonl"
    with manifest.open("w", encoding="utf-8") as file:
        for sample in samples:
            file.write(json.dumps(asdict(sample), ensure_ascii=False) + "\n")
    (output / "export-errors.json").write_text(json.dumps(errors, indent=2), encoding="utf-8")
    print(f"Wrote {len(samples)} labeled crops to {manifest}; {len(errors)} errors", flush=True)


def load_samples(data_dir: Path) -> list[Sample]:
    manifest = data_dir / "manifest.jsonl"
    rows = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [Sample(**row) for row in rows if row.get("include", True)]


def image_data_url(path: Path, max_size: int = 160) -> str:
    image = Image.open(path).convert("RGB")
    image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=78, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


def write_dataset_preview(data_dir: Path, destination: Path, per_pet: int) -> None:
    samples = load_samples(data_dir)
    grouped: dict[str, list[Sample]] = defaultdict(list)
    for sample in samples:
        grouped[sample.pet_id].append(sample)
    sections: list[str] = []
    for pet_samples in sorted(grouped.values(), key=lambda values: values[0].pet_name.casefold()):
        selected = deterministic_sample(pet_samples, per_pet, f"preview:{pet_samples[0].pet_id}")
        images = "".join(
            f'<figure><img loading="lazy" src="{image_data_url(data_dir / sample.crop_path)}" '
            f'alt="{html.escape(sample.pet_name)} crop"><figcaption>{html.escape(sample.source_type.lower())}'
            f'{f" · {sample.frame_timestamp_ms / 1000:.1f}s" if sample.frame_timestamp_ms else ""}</figcaption></figure>'
            for sample in selected
        )
        sections.append(
            f'<section><h2>{html.escape(pet_samples[0].pet_name)} '
            f'<small>{html.escape(pet_samples[0].species)} · {len(pet_samples)} samples · '
            f'{len({sample.asset_id for sample in pet_samples})} media</small></h2><div class="grid">{images}</div></section>'
        )
    counts = Counter(sample.species for sample in samples)
    document = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Named pet evaluation data</title><style>
:root{{color-scheme:light dark;font-family:Inter,system-ui,sans-serif;background:#0b0d10;color:#f4f5f7}}
body{{margin:0;padding:28px;max-width:1500px}}h1{{font-size:24px;margin:0 0 6px}}p,small,figcaption{{color:#9ca3af}}
section{{margin:30px 0}}h2{{display:flex;gap:12px;align-items:baseline;margin:0 0 12px}}h2 small{{font-size:13px;font-weight:400}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px}}
figure{{margin:0;min-width:0}}img{{width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px;background:#1f2937}}
figcaption{{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}}
@media(prefers-color-scheme:light){{:root{{background:#f8fafc;color:#111827}}}}
</style></head><body><h1>Named pet evaluation data</h1>
<p>{len(samples)} crops · {len(grouped)} named pets · {html.escape(str(dict(counts)))}</p>{''.join(sections)}</body></html>"""
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(document, encoding="utf-8")
    print(f"Wrote {destination}")


class Embedder:
    name: str

    def encode(self, paths: Sequence[Path], batch_size: int) -> np.ndarray:
        raise NotImplementedError


class HuggingFaceEmbedder(Embedder):
    def __init__(self, name: str, repo: str, family: str, base_repo: str, device: str) -> None:
        import torch
        from transformers import AutoImageProcessor, AutoModel, AutoProcessor

        self.name = name
        self.family = family
        self.torch = torch
        self.device = device
        if family == "dinov2":
            self.model = AutoModel.from_pretrained(base_repo, trust_remote_code=False)
            self.processor = AutoImageProcessor.from_pretrained(base_repo, use_fast=True)
            self._load_wrapped_weights(repo, "backbone.")
        elif family == "siglip":
            self.model = AutoModel.from_pretrained(base_repo, trust_remote_code=False)
            self.processor = AutoProcessor.from_pretrained(base_repo, use_fast=True)
            self._load_wrapped_weights(repo, "clip.")
        else:
            self.model = AutoModel.from_pretrained(repo, trust_remote_code=False)
            self.processor = AutoProcessor.from_pretrained(base_repo, use_fast=True)
        self.model = self.model.to(device).eval()

    def _load_wrapped_weights(self, repo: str, prefix: str) -> None:
        from huggingface_hub import hf_hub_download
        from safetensors.torch import load_file

        state = load_file(hf_hub_download(repo_id=repo, filename="model.safetensors"))
        state = {key.removeprefix(prefix): value for key, value in state.items() if key.startswith(prefix)}
        if not state:
            raise ValueError(f"Checkpoint {repo} did not contain expected {prefix!r} weights")
        missing, unexpected = self.model.load_state_dict(state, strict=False)
        if missing or unexpected:
            raise ValueError(
                f"Checkpoint {repo} is incompatible with {self.model.__class__.__name__}: "
                f"{len(missing)} missing and {len(unexpected)} unexpected keys"
            )

    def encode(self, paths: Sequence[Path], batch_size: int) -> np.ndarray:
        batches: list[np.ndarray] = []
        for start in range(0, len(paths), batch_size):
            images = [Image.open(path).convert("RGB") for path in paths[start : start + batch_size]]
            inputs = self.processor(images=images, return_tensors="pt").to(self.device)
            with self.torch.inference_mode():
                if self.family in {"clip", "siglip"} and hasattr(self.model, "get_image_features"):
                    features = self.model.get_image_features(**inputs)
                else:
                    output = self.model(**inputs)
                    features = output.last_hidden_state[:, 0, :]
                features = self.torch.nn.functional.normalize(features.float(), dim=1)
            batches.append(features.cpu().numpy())
            print(f"  {min(start + batch_size, len(paths))}/{len(paths)}", flush=True)
        return np.concatenate(batches).astype(np.float32)


class CurrentOnnxEmbedder(Embedder):
    def __init__(self, model_path: Path, device: str) -> None:
        import onnxruntime as ort

        self.name = "current"
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if device.startswith("cuda") else ["CPUExecutionProvider"]
        self.session = ort.InferenceSession(str(model_path), providers=providers)
        self.input_name = self.session.get_inputs()[0].name
        self.mean = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
        self.std = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)

    def encode(self, paths: Sequence[Path], batch_size: int) -> np.ndarray:
        outputs: list[np.ndarray] = []
        for path in paths:
            image = ImageOps.fit(Image.open(path).convert("RGB"), (224, 224), method=Image.Resampling.BICUBIC)
            array = np.asarray(image, dtype=np.float32) / 255.0
            array = ((array - self.mean) / self.std).transpose(2, 0, 1)[None]
            embedding = np.asarray(self.session.run(None, {self.input_name: array})[0][0], dtype=np.float32)
            embedding /= max(float(np.linalg.norm(embedding)), 1e-12)
            outputs.append(embedding)
        return np.stack(outputs)


class PrecomputedEmbedder(Embedder):
    def __init__(self, path: Path) -> None:
        self.name = "current"
        self.embeddings = np.load(path).astype(np.float32)

    def encode(self, paths: Sequence[Path], batch_size: int) -> np.ndarray:
        if len(self.embeddings) != len(paths):
            raise ValueError(f"Precomputed embeddings have {len(self.embeddings)} rows; expected {len(paths)}")
        return self.embeddings


def build_embedder(name: str, args: argparse.Namespace) -> Embedder:
    if name == "current":
        if args.current_embeddings:
            return PrecomputedEmbedder(Path(args.current_embeddings))
        if not args.current_onnx:
            raise ValueError("--current-onnx or --current-embeddings is required for the current model")
        return CurrentOnnxEmbedder(Path(args.current_onnx), args.device)
    if name not in MODEL_SPECS:
        raise ValueError(f"Unknown model {name!r}. Choose from current,{','.join(MODEL_SPECS)}")
    repo, family, base_repo = MODEL_SPECS[name]
    return HuggingFaceEmbedder(name, repo, family, base_repo, args.device)


def cosine_distances(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    return np.clip(1.0 - left @ right.T, 0.0, 2.0)


def identity_label(sample: Sample) -> str:
    """Treat duplicate Immich clusters with the same assigned name as one identity."""
    return f"{sample.species.casefold()}:{sample.pet_name.strip().casefold()}"


def equal_error_rate(positive: np.ndarray, negative: np.ndarray) -> float:
    values = np.unique(np.concatenate([positive, negative]))
    if len(values) > 5000:
        values = np.quantile(values, np.linspace(0, 1, 5000))
    false_reject = np.array([(positive > threshold).mean() for threshold in values])
    false_accept = np.array([(negative <= threshold).mean() for threshold in values])
    index = int(np.argmin(np.abs(false_reject - false_accept)))
    return float((false_reject[index] + false_accept[index]) / 2)


def evaluate_embeddings(samples: Sequence[Sample], embeddings: np.ndarray) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    labels = np.array([identity_label(sample) for sample in samples])
    names = {identity_label(sample): sample.pet_name for sample in samples}
    assets = np.array([sample.asset_id for sample in samples])
    distances = cosine_distances(embeddings, embeddings)
    np.fill_diagonal(distances, np.inf)
    query_results: list[dict[str, Any]] = []
    positive_pairs: list[float] = []
    negative_pairs: list[float] = []

    for index, sample in enumerate(samples):
        valid = assets != sample.asset_id
        sample_label = identity_label(sample)
        if not np.any(valid & (labels == sample_label)):
            continue
        candidate_indexes = np.flatnonzero(valid)
        ordered = candidate_indexes[np.argsort(distances[index, candidate_indexes])]
        ranked_pets: list[str] = []
        for candidate in ordered:
            if labels[candidate] not in ranked_pets:
                ranked_pets.append(str(labels[candidate]))
        correct_distances = distances[index, valid & (labels == sample_label)]
        wrong_distances = distances[index, valid & (labels != sample_label)]
        best_correct = float(np.min(correct_distances))
        best_wrong = float(np.min(wrong_distances)) if len(wrong_distances) else math.inf
        positive_pairs.extend(correct_distances[np.isfinite(correct_distances)].tolist())
        negative_pairs.extend(wrong_distances.tolist())
        query_results.append(
            {
                "sampleIndex": index,
                "sampleId": sample.sample_id,
                "petId": sample.pet_id,
                "identityLabel": sample_label,
                "petName": sample.pet_name,
                "assetId": sample.asset_id,
                "predictedPetId": ranked_pets[0],
                "predictedPetName": names[ranked_pets[0]],
                "top1": ranked_pets[0] == sample_label,
                "top3": sample_label in ranked_pets[:3],
                "bestCorrectDistance": best_correct,
                "bestWrongDistance": best_wrong,
                "margin": best_wrong - best_correct,
            }
        )

    if not query_results:
        raise ValueError("No pet has labeled samples in at least two different assets")
    per_pet: dict[str, list[bool]] = defaultdict(list)
    for result in query_results:
        per_pet[result["petName"]].append(result["top1"])
    metrics = {
        "queries": len(query_results),
        "pets": len(per_pet),
        "top1": statistics.fmean(result["top1"] for result in query_results),
        "top3": statistics.fmean(result["top3"] for result in query_results),
        "macroTop1": statistics.fmean(statistics.fmean(values) for values in per_pet.values()),
        "falseMatchRate": statistics.fmean(not result["top1"] for result in query_results),
        "medianMargin": statistics.median(result["margin"] for result in query_results),
        "eer": equal_error_rate(np.asarray(positive_pairs), np.asarray(negative_pairs)),
        "perPetTop1": {name: statistics.fmean(values) for name, values in sorted(per_pet.items())},
    }
    return metrics, query_results


def project_embeddings(embeddings: np.ndarray, seed: int) -> np.ndarray:
    try:
        import umap

        neighbors = min(15, max(2, len(embeddings) - 1))
        return umap.UMAP(n_components=2, metric="cosine", n_neighbors=neighbors, min_dist=0.12, random_state=seed).fit_transform(embeddings)
    except Exception as error:  # noqa: BLE001
        print(f"UMAP failed ({error}); using PCA", file=sys.stderr)
        from sklearn.decomposition import PCA

        return PCA(n_components=2, random_state=seed).fit_transform(embeddings)


def write_model_report(
    destination: Path,
    data_dir: Path,
    model_name: str,
    samples: Sequence[Sample],
    metrics: dict[str, Any],
    results: Sequence[dict[str, Any]],
    projection: np.ndarray,
) -> None:
    import plotly.express as px
    import plotly.io as pio

    hover = [f"{sample.pet_name}<br>{sample.source_type.lower()}<br>{sample.asset_id[:8]}" for sample in samples]
    figure = px.scatter(
        x=projection[:, 0],
        y=projection[:, 1],
        color=[sample.pet_name for sample in samples],
        hover_name=hover,
        labels={"x": "Embedding projection 1", "y": "Embedding projection 2", "color": "Pet"},
    )
    figure.update_traces(marker={"size": 8, "opacity": 0.78})
    figure.update_layout(template="plotly_dark", margin={"l": 45, "r": 20, "t": 20, "b": 45}, height=620)
    chart = pio.to_html(figure, include_plotlyjs="cdn", full_html=False)
    mistakes = sorted((result for result in results if not result["top1"]), key=lambda value: value["margin"])[:40]
    mistake_html = "".join(
        f'<article><img src="{image_data_url(data_dir / samples[result["sampleIndex"]].crop_path, 150)}" '
        f'alt="{html.escape(result["petName"])}"><div><strong>{html.escape(result["petName"])}</strong>'
        f'<span>→ {html.escape(result["predictedPetName"])}</span><small>margin {result["margin"]:.3f}</small></div></article>'
        for result in mistakes
    ) or "<p>No cross-asset top-1 mistakes.</p>"
    rows = "".join(f"<tr><td>{html.escape(name)}</td><td>{score:.1%}</td></tr>" for name, score in metrics["perPetTop1"].items())
    document = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{html.escape(model_name)} pet evaluation</title><style>
:root{{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b0d10;color:#f4f5f7}}body{{margin:0;padding:28px;max-width:1600px}}
h1{{font-size:24px}}h2{{margin-top:34px}}.metrics{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}}
.metric{{padding:14px;background:#151922;border:1px solid #293244;border-radius:12px}}.metric b{{display:block;font-size:22px}}.metric span,small{{color:#9ca3af}}
.mistakes{{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}}article{{display:flex;gap:10px;align-items:center;background:#151922;padding:8px;border-radius:12px}}
article img{{width:72px;height:72px;object-fit:cover;border-radius:9px}}article div,article span,article small{{display:block;min-width:0}}table{{border-collapse:collapse;width:min(520px,100%)}}td{{padding:7px 4px;border-bottom:1px solid #293244}}td:last-child{{text-align:right}}
</style></head><body><h1>{html.escape(model_name)}</h1><div class="metrics">
<div class="metric"><b>{metrics['top1']:.1%}</b><span>Top-1</span></div><div class="metric"><b>{metrics['top3']:.1%}</b><span>Top-3</span></div>
<div class="metric"><b>{metrics['macroTop1']:.1%}</b><span>Macro top-1</span></div><div class="metric"><b>{metrics['eer']:.1%}</b><span>EER</span></div>
<div class="metric"><b>{metrics['medianMargin']:.3f}</b><span>Median margin</span></div><div class="metric"><b>{metrics['queries']}</b><span>Cross-media queries</span></div>
</div><h2>Embedding projection</h2>{chart}<h2>Closest wrong matches</h2><div class="mistakes">{mistake_html}</div>
<h2>Top-1 by pet</h2><table>{rows}</table></body></html>"""
    destination.write_text(document, encoding="utf-8")


def write_comparison(output_dir: Path, summaries: list[dict[str, Any]]) -> None:
    ordered = sorted(summaries, key=lambda item: (item["metrics"]["macroTop1"], -item["metrics"]["eer"]), reverse=True)
    rows = "".join(
        f'<tr><td><a href="{html.escape(item["report"])}">{html.escape(item["model"])}</a></td>'
        f'<td>{item["dimensions"]}</td><td>{item["metrics"]["top1"]:.1%}</td><td>{item["metrics"]["top3"]:.1%}</td>'
        f'<td>{item["metrics"]["macroTop1"]:.1%}</td><td>{item["metrics"]["eer"]:.1%}</td>'
        f'<td>{item["metrics"]["medianMargin"]:.3f}</td></tr>'
        for item in ordered
    )
    document = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pet model comparison</title>
<style>:root{{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b0d10;color:#f4f5f7}}body{{padding:28px}}table{{border-collapse:collapse;width:100%;max-width:1100px}}th,td{{padding:11px;text-align:right;border-bottom:1px solid #293244}}th:first-child,td:first-child{{text-align:left}}a{{color:#93c5fd}}</style></head>
<body><h1>Pet model comparison</h1><table><thead><tr><th>Model</th><th>Dims</th><th>Top-1</th><th>Top-3</th><th>Macro top-1</th><th>EER</th><th>Margin</th></tr></thead><tbody>{rows}</tbody></table></body></html>"""
    (output_dir / "comparison.html").write_text(document, encoding="utf-8")


def evaluate_models(args: argparse.Namespace) -> None:
    data_dir = Path(args.data).resolve()
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    samples = load_samples(data_dir)
    if len({identity_label(sample) for sample in samples}) < 2:
        raise SystemExit("At least two named pets are required")
    paths = [data_dir / sample.crop_path for sample in samples]
    summaries: list[dict[str, Any]] = []
    for model_name in [name.strip() for name in args.models.split(",") if name.strip()]:
        print(f"Loading {model_name}", flush=True)
        embedder = build_embedder(model_name, args)
        embeddings = embedder.encode(paths, args.batch_size)
        metrics, results = evaluate_embeddings(samples, embeddings)
        projection = project_embeddings(embeddings, args.seed)
        model_dir = output_dir / model_name
        model_dir.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(model_dir / "embeddings.npz", embeddings=embeddings, projection=projection)
        (model_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
        (model_dir / "queries.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
        write_model_report(model_dir / "report.html", data_dir, model_name, samples, metrics, results, projection)
        summaries.append(
            {"model": model_name, "dimensions": int(embeddings.shape[1]), "metrics": metrics, "report": f"{model_name}/report.html"}
        )
        print(f"{model_name}: top-1={metrics['top1']:.1%}, macro={metrics['macroTop1']:.1%}, EER={metrics['eer']:.1%}")
        del embedder
    (output_dir / "summary.json").write_text(json.dumps(summaries, indent=2), encoding="utf-8")
    write_comparison(output_dir, summaries)
    print(f"Wrote comparison to {output_dir / 'comparison.html'}")


def encode_current(args: argparse.Namespace) -> None:
    data_dir = Path(args.data).resolve()
    samples = load_samples(data_dir)
    paths = [data_dir / sample.crop_path for sample in samples]
    embeddings = CurrentOnnxEmbedder(Path(args.current_onnx), args.device).encode(paths, args.batch_size)
    destination = Path(args.output).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    np.save(destination, embeddings)
    print(f"Wrote {embeddings.shape[0]} current-model embeddings to {destination}")


def load_oxford_species_samples(
    data_dir: Path, split: str, per_species: int, seed: int
) -> list[tuple[Path, str]]:
    annotations = data_dir / "annotations" / f"{split}.txt"
    images_dir = data_dir / "images"
    if not annotations.is_file() or not images_dir.is_dir():
        raise FileNotFoundError(
            f"Expected Oxford-IIIT Pet images and annotations under {data_dir}; see the README download commands"
        )
    grouped: dict[str, list[Path]] = defaultdict(list)
    for line in annotations.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        image_id, _breed_id, species_id, _breed_index = line.split()
        species = OXFORD_SPECIES[int(species_id)]
        path = images_dir / f"{image_id}.jpg"
        if path.is_file():
            grouped[species].append(path)
    selected: list[tuple[Path, str]] = []
    for species, paths in sorted(grouped.items()):
        species_paths = sorted(paths)
        if per_species > 0:
            species_paths = deterministic_sample(species_paths, per_species, f"oxford:{split}:{species}:{seed}")
        for path in species_paths:
            selected.append((path, species))
    return selected


def species_metrics(
    rows: Sequence[dict[str, Any]], threshold: float
) -> dict[str, Any]:
    confusion = {"cat": {"cat": 0, "dog": 0, "missed": 0}, "dog": {"cat": 0, "dog": 0, "missed": 0}}
    for row in rows:
        expected = row["expected"]
        predicted = row["predicted"] if row["score"] >= threshold else "missed"
        confusion[expected][predicted] += 1
    total = len(rows)
    detected = sum(confusion[expected][predicted] for expected in OXFORD_SPECIES.values() for predicted in OXFORD_SPECIES.values())
    correct = sum(confusion[species][species] for species in OXFORD_SPECIES.values())
    per_species = {}
    for species in OXFORD_SPECIES.values():
        species_total = sum(confusion[species].values())
        species_detected = species_total - confusion[species]["missed"]
        per_species[species] = {
            "samples": species_total,
            "detectionRecall": species_detected / species_total if species_total else 0,
            "conditionalAccuracy": confusion[species][species] / species_detected if species_detected else 0,
            "endToEndAccuracy": confusion[species][species] / species_total if species_total else 0,
        }
    balanced_detection_recall = statistics.fmean(value["detectionRecall"] for value in per_species.values())
    balanced_end_to_end = statistics.fmean(value["endToEndAccuracy"] for value in per_species.values())
    return {
        "threshold": threshold,
        "samples": total,
        "detectionRecall": detected / total,
        "conditionalAccuracy": correct / detected if detected else 0,
        "endToEndAccuracy": correct / total,
        "balancedDetectionRecall": balanced_detection_recall,
        "balancedEndToEndAccuracy": balanced_end_to_end,
        "confusion": confusion,
        "perSpecies": per_species,
    }


def write_species_report(destination: Path, summaries: Sequence[dict[str, Any]]) -> None:
    table_rows = []
    for summary in summaries:
        for metrics in summary["thresholds"]:
            confusion = metrics["confusion"]
            table_rows.append(
                f"<tr><td>{html.escape(summary['model'])}</td><td>{metrics['threshold']:.2f}</td>"
                f"<td>{metrics['detectionRecall']:.1%}</td><td>{metrics['conditionalAccuracy']:.1%}</td>"
                f"<td>{metrics['endToEndAccuracy']:.1%}</td><td>{metrics['balancedEndToEndAccuracy']:.1%}</td>"
                f"<td>{confusion['cat']['dog']}</td>"
                f"<td>{confusion['dog']['cat']}</td><td>{confusion['cat']['missed'] + confusion['dog']['missed']}</td></tr>"
            )
    document = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Cat and dog detection benchmark</title><style>
:root{{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b0d10;color:#f4f5f7}}body{{padding:28px}}
table{{border-collapse:collapse;width:100%;max-width:1200px}}th,td{{padding:10px;text-align:right;border-bottom:1px solid #293244}}
th:first-child,td:first-child{{text-align:left}}p{{color:#9ca3af}}</style></head><body><h1>Cat and dog detection benchmark</h1>
<p>Oxford-IIIT Pet official split. Conditional accuracy excludes missed pets; balanced end-to-end gives cats and dogs equal weight.</p>
<table><thead><tr><th>Model</th><th>Threshold</th><th>Detection recall</th><th>Species accuracy</th><th>End-to-end</th><th>Balanced end-to-end</th>
<th>Cat→dog</th><th>Dog→cat</th><th>Missed</th></tr></thead><tbody>{''.join(table_rows)}</tbody></table></body></html>"""
    destination.write_text(document, encoding="utf-8")


def annotated_species_data_url(path: Path, box: Sequence[float] | None, max_size: int = 220) -> str:
    image = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    source_width, source_height = image.size
    image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    if box:
        scale_x = image.width / source_width
        scale_y = image.height / source_height
        x1, y1, x2, y2 = box
        draw = ImageDraw.Draw(image)
        width = max(2, round(min(image.width, image.height) * 0.018))
        draw.rectangle(
            (x1 * scale_x, y1 * scale_y, x2 * scale_x, y2 * scale_y),
            outline=(96, 165, 250),
            width=width,
        )
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=72, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


def write_species_failure_preview(
    destination: Path,
    data_dir: Path,
    model_name: str,
    rows: Sequence[dict[str, Any]],
    threshold: float,
) -> None:
    failures: dict[str, list[dict[str, Any]]] = {"wrong": [], "missed": []}
    for row in rows:
        predicted = row["predicted"] if row["score"] >= threshold else "missed"
        if predicted == row["expected"]:
            continue
        failures["missed" if predicted == "missed" else "wrong"].append({**row, "result": predicted})

    def cards(items: Sequence[dict[str, Any]]) -> str:
        rendered = []
        for row in sorted(items, key=lambda item: (item["expected"], item["image"].casefold())):
            path = data_dir / "images" / row["image"]
            breed = Path(row["image"]).stem.rsplit("_", 1)[0].replace("_", " ")
            raw_prediction = row["predicted"] or "none"
            detail = (
                f"{row['expected']} → {row['result']} · {row['score']:.0%}"
                if row["result"] != "missed"
                else f"expected {row['expected']} · raw {raw_prediction} {row['score']:.0%}"
            )
            rendered.append(
                f'<article><img loading="lazy" src="{annotated_species_data_url(path, row.get("box"))}" '
                f'alt="{html.escape(breed)}: {html.escape(detail)}"><div><strong>{html.escape(breed)}</strong>'
                f'<span>{html.escape(detail)}</span><small>{html.escape(row["image"])}</small></div></article>'
            )
        return "".join(rendered)

    wrong = failures["wrong"]
    missed = failures["missed"]
    document = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{html.escape(model_name)} cat/dog failures</title><style>
:root{{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b0d10;color:#f4f5f7}}body{{margin:0;padding:28px;max-width:1600px}}
h1{{margin-bottom:4px}}p,span,small{{color:#9ca3af}}section{{margin-top:34px}}.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}}
article{{min-width:0}}img{{width:100%;aspect-ratio:1;object-fit:contain;background:#151922;border-radius:12px}}article div{{padding-top:7px}}strong,span,small{{display:block}}
span,small{{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}small{{margin-top:2px;color:#6b7280}}.legend{{display:inline-block;width:18px;border-top:3px solid #60a5fa;margin-right:6px}}
</style></head><body><h1>{html.escape(model_name)} failures at {threshold:.2f}</h1>
<p>{len(wrong) + len(missed)} failures · {len(wrong)} wrong-species classifications · {len(missed)} missed detections · <span class="legend"></span>best raw detection box</p>
<section><h2>Wrong species ({len(wrong)})</h2><div class="grid">{cards(wrong)}</div></section>
<section><h2>Missed at threshold ({len(missed)})</h2><div class="grid">{cards(missed)}</div></section></body></html>"""
    destination.write_text(document, encoding="utf-8")


def evaluate_species(args: argparse.Namespace) -> None:
    from immich_ml.models import PetDetector

    data_dir = Path(args.data).resolve()
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    samples = load_oxford_species_samples(data_dir, args.split, args.per_species, args.seed)
    thresholds = [float(value) for value in args.thresholds.split(",") if value.strip()]
    summaries: list[dict[str, Any]] = []
    for model_name in [value.strip() for value in args.models.split(",") if value.strip()]:
        print(f"Loading {model_name} for {len(samples)} labeled cat/dog images", flush=True)
        cache_dir = Path(args.cache) / model_name if args.cache else None
        detector = PetDetector(model_name, min_score=args.raw_min_score, cache_dir=cache_dir)
        rows: list[dict[str, Any]] = []
        for index, (path, expected) in enumerate(samples, start=1):
            output = detector.predict(path.read_bytes())
            if len(output["scores"]):
                best = int(np.argmax(output["scores"]))
                predicted = output["species"][best]
                score = float(output["scores"][best])
                box = [float(value) for value in output["boxes"][best]]
            else:
                predicted = None
                score = 0.0
                box = None
            rows.append({"image": path.name, "expected": expected, "predicted": predicted, "score": score, "box": box})
            if index % 50 == 0 or index == len(samples):
                print(f"  {index}/{len(samples)}", flush=True)
        model_summary = {
            "model": model_name,
            "thresholds": [species_metrics(rows, threshold) for threshold in thresholds],
        }
        summaries.append(model_summary)
        (output_dir / f"{model_name}-predictions.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
        preview_threshold = max(thresholds)
        write_species_failure_preview(
            output_dir / f"{model_name}-failures-{preview_threshold:.2f}.html",
            data_dir,
            model_name,
            rows,
            preview_threshold,
        )
    (output_dir / "species-summary.json").write_text(json.dumps(summaries, indent=2), encoding="utf-8")
    write_species_report(output_dir / "species-report.html", summaries)
    print(f"Wrote species benchmark to {output_dir / 'species-report.html'}")


class ZeroShotSpeciesClassifier:
    def __init__(self, name: str, device: str) -> None:
        import torch
        from transformers import AutoModel, AutoProcessor

        if name not in ZERO_SHOT_MODEL_SPECS:
            raise ValueError(f"Unknown zero-shot model {name!r}")
        direct_repo, wrapped_name = ZERO_SHOT_MODEL_SPECS[name]
        if wrapped_name:
            repo, family, base_repo = MODEL_SPECS[wrapped_name]
            if family not in {"clip", "siglip"}:
                raise ValueError(f"{wrapped_name} has no text encoder")
            embedder = HuggingFaceEmbedder(wrapped_name, repo, family, base_repo, device)
            self.model = embedder.model
            self.processor = embedder.processor
        else:
            self.model = AutoModel.from_pretrained(direct_repo, trust_remote_code=False).to(device).eval()
            self.processor = AutoProcessor.from_pretrained(direct_repo, use_fast=True)
        self.name = name
        self.device = device
        self.torch = torch
        prompts = [
            "a photo of a cat",
            "a close-up photo of a cat",
            "a domestic cat",
            "a photo of a dog",
            "a close-up photo of a dog",
            "a domestic dog",
        ]
        text_inputs = self.processor(text=prompts, padding="max_length", return_tensors="pt").to(device)
        with torch.inference_mode():
            text_features = self.model.get_text_features(**text_inputs).float()
            text_features = torch.nn.functional.normalize(text_features, dim=1)
            cat = torch.nn.functional.normalize(text_features[:3].mean(dim=0), dim=0)
            dog = torch.nn.functional.normalize(text_features[3:].mean(dim=0), dim=0)
            self.text_features = torch.stack([cat, dog])

    def classify(self, paths: Sequence[Path], batch_size: int) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        labels = ("cat", "dog")
        for start in range(0, len(paths), batch_size):
            batch_paths = paths[start : start + batch_size]
            images = [Image.open(path).convert("RGB") for path in batch_paths]
            inputs = self.processor(images=images, return_tensors="pt").to(self.device)
            with self.torch.inference_mode():
                image_features = self.model.get_image_features(**inputs).float()
                image_features = self.torch.nn.functional.normalize(image_features, dim=1)
                similarities = image_features @ self.text_features.T
                probabilities = self.torch.softmax(similarities * 20, dim=1)
            for path, similarity, probability in zip(batch_paths, similarities.cpu(), probabilities.cpu()):
                best = int(self.torch.argmax(similarity))
                other = 1 - best
                results.append(
                    {
                        "image": path.name,
                        "predicted": labels[best],
                        "confidence": float(probability[best]),
                        "margin": float(similarity[best] - similarity[other]),
                    }
                )
            print(f"  {min(start + batch_size, len(paths))}/{len(paths)}", flush=True)
        return results


def zero_shot_metrics(rows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    confusion = {"cat": {"cat": 0, "dog": 0}, "dog": {"cat": 0, "dog": 0}}
    for row in rows:
        confusion[row["expected"]][row["predicted"]] += 1
    per_species = {}
    for species in ("cat", "dog"):
        total = sum(confusion[species].values())
        per_species[species] = confusion[species][species] / total if total else 0
    return {
        "samples": len(rows),
        "accuracy": sum(confusion[value][value] for value in ("cat", "dog")) / len(rows),
        "balancedAccuracy": statistics.fmean(per_species.values()),
        "confusion": confusion,
        "perSpeciesAccuracy": per_species,
        "medianMargin": statistics.median(row["margin"] for row in rows),
    }


def write_zero_shot_report(destination: Path, summaries: Sequence[dict[str, Any]]) -> None:
    rows = "".join(
        f"<tr><td>{html.escape(summary['model'])}</td><td>{summary['metrics']['accuracy']:.1%}</td>"
        f"<td>{summary['metrics']['balancedAccuracy']:.1%}</td>"
        f"<td>{summary['metrics']['perSpeciesAccuracy']['cat']:.1%}</td>"
        f"<td>{summary['metrics']['perSpeciesAccuracy']['dog']:.1%}</td>"
        f"<td>{summary['metrics']['confusion']['cat']['dog']}</td>"
        f"<td>{summary['metrics']['confusion']['dog']['cat']}</td>"
        f"<td>{summary['metrics']['medianMargin']:.3f}</td></tr>"
        for summary in summaries
    )
    document = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Cat/dog zero-shot classification</title><style>:root{{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b0d10;color:#f4f5f7}}body{{padding:28px}}
table{{border-collapse:collapse;width:100%;max-width:1100px}}th,td{{padding:10px;text-align:right;border-bottom:1px solid #293244}}th:first-child,td:first-child{{text-align:left}}p{{color:#9ca3af}}</style></head>
<body><h1>Cat/dog zero-shot classification</h1><p>Classification on known pet crops; this does not measure localization or segmentation.</p>
<table><thead><tr><th>Model</th><th>Accuracy</th><th>Balanced</th><th>Cats</th><th>Dogs</th><th>Cat→dog</th><th>Dog→cat</th><th>Median margin</th></tr></thead><tbody>{rows}</tbody></table></body></html>"""
    destination.write_text(document, encoding="utf-8")


def evaluate_zero_shot_species(args: argparse.Namespace) -> None:
    data_dir = Path(args.data).resolve()
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    samples = load_oxford_species_samples(data_dir, args.split, args.per_species, args.seed)
    paths = [path for path, _species in samples]
    expected = [species for _path, species in samples]
    summaries = []
    for model_name in [value.strip() for value in args.models.split(",") if value.strip()]:
        print(f"Loading {model_name} for {len(paths)} cat/dog crops", flush=True)
        classifier = ZeroShotSpeciesClassifier(model_name, args.device)
        rows = classifier.classify(paths, args.batch_size)
        for row, species in zip(rows, expected):
            row["expected"] = species
        metrics = zero_shot_metrics(rows)
        summaries.append({"model": model_name, "metrics": metrics})
        (output_dir / f"{model_name}-predictions.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
        print(f"{model_name}: balanced={metrics['balancedAccuracy']:.1%}", flush=True)
        del classifier
    (output_dir / "zero-shot-summary.json").write_text(json.dumps(summaries, indent=2), encoding="utf-8")
    write_zero_shot_report(output_dir / "zero-shot-report.html", summaries)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    export_parser = subparsers.add_parser("export", help="Export named pet crops from Immich")
    export_parser.add_argument("--url", required=True)
    export_parser.add_argument("--api-key")
    export_parser.add_argument("--access-token")
    export_parser.add_argument("--output", required=True)
    export_parser.add_argument("--species", choices=["all", "dog", "cat"], default="all")
    export_parser.add_argument("--include-unnamed", action="store_true", help="Include unlabelled auto-clusters")
    export_parser.add_argument("--max-assets-per-pet", type=int, default=120)
    export_parser.add_argument("--max-samples-per-pet", type=int, default=120)
    export_parser.add_argument("--max-samples-per-asset", type=int, default=4)
    export_parser.add_argument("--crop-size", type=int, default=640)
    export_parser.set_defaults(func=export_dataset)

    preview_parser = subparsers.add_parser("preview", help="Render a labeled crop contact sheet")
    preview_parser.add_argument("--data", required=True)
    preview_parser.add_argument("--output", required=True)
    preview_parser.add_argument("--per-pet", type=int, default=24)
    preview_parser.set_defaults(
        func=lambda args: write_dataset_preview(Path(args.data).resolve(), Path(args.output).resolve(), args.per_pet)
    )

    evaluate_parser = subparsers.add_parser("evaluate", help="Evaluate embedding models")
    evaluate_parser.add_argument("--data", required=True)
    evaluate_parser.add_argument("--output", required=True)
    evaluate_parser.add_argument("--models", default="avito-dinov2-small,avito-zer0int-clip-l,avito-siglip2-base")
    evaluate_parser.add_argument("--current-onnx")
    evaluate_parser.add_argument("--current-embeddings")
    evaluate_parser.add_argument("--device", default="cuda")
    evaluate_parser.add_argument("--batch-size", type=int, default=32)
    evaluate_parser.add_argument("--seed", type=int, default=42)
    evaluate_parser.set_defaults(func=evaluate_models)

    current_parser = subparsers.add_parser("encode-current", help="Encode crops with the deployed ONNX model")
    current_parser.add_argument("--data", required=True)
    current_parser.add_argument("--current-onnx", required=True)
    current_parser.add_argument("--output", required=True)
    current_parser.add_argument("--device", default="cuda")
    current_parser.add_argument("--batch-size", type=int, default=32)
    current_parser.set_defaults(func=encode_current)

    species_parser = subparsers.add_parser("evaluate-species", help="Evaluate deployed YOLOX cat/dog detection")
    species_parser.add_argument("--data", required=True)
    species_parser.add_argument("--output", required=True)
    species_parser.add_argument("--cache")
    species_parser.add_argument("--models", default="yolox_s,yolox_m,yolox_x")
    species_parser.add_argument("--thresholds", default="0.25,0.50,0.65")
    species_parser.add_argument("--raw-min-score", type=float, default=0.01)
    species_parser.add_argument("--split", choices=["trainval", "test"], default="test")
    species_parser.add_argument("--per-species", type=int, default=200, help="Samples per species; 0 uses the full split")
    species_parser.add_argument("--seed", type=int, default=42)
    species_parser.set_defaults(func=evaluate_species)

    zero_shot_parser = subparsers.add_parser("evaluate-zero-shot-species", help="Evaluate vision-language models on cat/dog crops")
    zero_shot_parser.add_argument("--data", required=True)
    zero_shot_parser.add_argument("--output", required=True)
    zero_shot_parser.add_argument("--models", default="google-siglip2-base,avito-zer0int-clip-l,avito-siglip2-base")
    zero_shot_parser.add_argument("--device", default="cuda")
    zero_shot_parser.add_argument("--batch-size", type=int, default=32)
    zero_shot_parser.add_argument("--split", choices=["trainval", "test"], default="test")
    zero_shot_parser.add_argument("--per-species", type=int, default=200, help="Samples per species; 0 uses the full split")
    zero_shot_parser.add_argument("--seed", type=int, default=42)
    zero_shot_parser.set_defaults(func=evaluate_zero_shot_species)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
