#!/usr/bin/env python3
"""Benchmark cat/dog detectors on Oxford-IIIT Pet and Immich frames.

The public track uses independent Oxford masks. The Immich track measures
agreement with reviewed stored sightings and must not be presented as an
independent estimate of detector accuracy.
"""

from __future__ import annotations

import argparse
import base64
import html
import io
import json
import os
import statistics
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image, ImageDraw, ImageOps

from pet_eval import ImmichClient, deterministic_sample


SPECIES = {1: "cat", 2: "dog"}


def bbox_iou(left: list[float], right: list[float]) -> float:
    x1, y1 = max(left[0], right[0]), max(left[1], right[1])
    x2, y2 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    left_area = max(0.0, left[2] - left[0]) * max(0.0, left[3] - left[1])
    right_area = max(0.0, right[2] - right[0]) * max(0.0, right[3] - right[1])
    union = left_area + right_area - intersection
    return intersection / union if union else 0.0


def mask_iou(left: np.ndarray, right: np.ndarray) -> float:
    intersection = np.logical_and(left, right).sum()
    union = np.logical_or(left, right).sum()
    return float(intersection / union) if union else 0.0


def mask_bbox(mask: np.ndarray) -> list[float]:
    ys, xs = np.nonzero(mask)
    if not len(xs):
        raise ValueError("Empty Oxford foreground mask")
    return [float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)]


def build_oxford(args: argparse.Namespace) -> None:
    source = Path(args.source).resolve()
    destination = Path(args.output).resolve()
    images_dir = destination / "images"
    masks_dir = destination / "masks"
    images_dir.mkdir(parents=True, exist_ok=True)
    masks_dir.mkdir(parents=True, exist_ok=True)
    grouped: dict[str, list[str]] = {"cat": [], "dog": []}
    split = source / "annotations" / f"{args.split}.txt"
    for line in split.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        image_id, _breed, species_id, _index = line.split()
        grouped[SPECIES[int(species_id)]].append(image_id)
    records: list[dict[str, Any]] = []
    for species, image_ids in grouped.items():
        chosen = sorted(image_ids)
        if args.per_species:
            chosen = deterministic_sample(chosen, args.per_species, f"detector:{args.split}:{species}:{args.seed}")
        for image_id in chosen:
            image_source = source / "images" / f"{image_id}.jpg"
            trimap_source = source / "annotations" / "trimaps" / f"{image_id}.png"
            image = ImageOps.exif_transpose(Image.open(image_source)).convert("RGB")
            trimap = np.asarray(Image.open(trimap_source))
            # Oxford: 1=foreground, 2=background, 3=boundary. Boundary belongs
            # to the object for localization and mask-IoU scoring.
            foreground = trimap != 2
            # A small number of distributed Oxford trimaps contain only the
            # background value. They cannot support localization/mask scoring.
            if not foreground.any():
                print(f"Skipping invalid empty trimap: {image_id}", flush=True)
                continue
            image_name = f"{image_id}.jpg"
            mask_name = f"{image_id}.png"
            image.save(images_dir / image_name, quality=95)
            Image.fromarray((foreground * 255).astype(np.uint8)).save(masks_dir / mask_name)
            records.append(
                {
                    "id": image_id,
                    "image": f"images/{image_name}",
                    "width": image.width,
                    "height": image.height,
                    "source": "oxford",
                    "annotations": [{"species": species, "bbox": mask_bbox(foreground), "mask": f"masks/{mask_name}"}],
                }
            )
    (destination / "dataset.json").write_text(json.dumps({"images": records}, indent=2), encoding="utf-8")
    print(f"Wrote {len(records)} Oxford images to {destination}")


def _scaled_bbox(sighting: dict[str, Any], width: int, height: int) -> list[float]:
    sx = width / max(1, int(sighting["imageWidth"]))
    sy = height / max(1, int(sighting["imageHeight"]))
    return [
        float(sighting["boundingBoxX1"]) * sx,
        float(sighting["boundingBoxY1"]) * sy,
        float(sighting["boundingBoxX2"]) * sx,
        float(sighting["boundingBoxY2"]) * sy,
    ]


def export_immich(args: argparse.Namespace) -> None:
    token = args.access_token or os.environ.get("IMMICH_ACCESS_TOKEN")
    key = args.api_key or os.environ.get("IMMICH_API_KEY")
    if not token and not key:
        raise SystemExit("Set IMMICH_ACCESS_TOKEN or IMMICH_API_KEY")
    source = json.loads(Path(args.source_manifest).read_text(encoding="utf-8"))
    rows = [row for species in ("cats", "dogs") for row in source.get(species, []) if row.get("include", True)]
    if args.per_species:
        rows = [
            row
            for species in ("cat", "dog")
            for row in deterministic_sample(
                [item for item in rows if item["species"] == species], args.per_species, f"immich-frames:{species}:{args.seed}"
            )
        ]
    destination = Path(args.output).resolve()
    frames_dir = destination / "images"
    frames_dir.mkdir(parents=True, exist_ok=True)
    client = ImmichClient(
        args.url,
        api_key=key,
        access_token=token,
        verify=not args.insecure,
        host_header=args.host_header,
    )
    records: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for index, row in enumerate(rows, start=1):
        try:
            sightings = client.get_json(f"/pets/assets/{row['asset_id']}")
            sighting = next(value for value in sightings if value["id"] == row["sighting_id"])
            if row["source_type"] == "VIDEO":
                content = client.get_bytes(f"/pets/assets/{sighting['id']}/thumbnail")
            else:
                content = client.get_bytes(f"/assets/{row['asset_id']}/thumbnail", {"size": "preview"})
            frame = ImageOps.exif_transpose(Image.open(io.BytesIO(content))).convert("RGB")
            filename = f"{sighting['id']}.jpg"
            frame.save(frames_dir / filename, quality=95)
            records.append(
                {
                    "id": sighting["id"],
                    "image": f"images/{filename}",
                    "width": frame.width,
                    "height": frame.height,
                    "source": "immich-reviewed-sighting",
                    "annotations": [
                        {
                            "species": row["species"],
                            "bbox": _scaled_bbox(sighting, frame.width, frame.height),
                            "petId": row["pet_id"],
                            "assetId": row["asset_id"],
                            "frameTimestampMs": row.get("frame_timestamp_ms", 0),
                        }
                    ],
                }
            )
        except Exception as error:  # noqa: BLE001
            errors.append({"sightingId": row["sighting_id"], "error": str(error)})
        if index % 25 == 0 or index == len(rows):
            print(f"  {index}/{len(rows)} frames", flush=True)
    (destination / "dataset.json").write_text(json.dumps({"images": records}, indent=2), encoding="utf-8")
    (destination / "errors.json").write_text(json.dumps(errors, indent=2), encoding="utf-8")
    print(f"Wrote {len(records)} Immich frames ({len(errors)} errors) to {destination}")


class Detector:
    def predict(self, image: Image.Image, threshold: float) -> list[dict[str, Any]]:
        raise NotImplementedError


class ImmichYoloxDetector(Detector):
    def __init__(self) -> None:
        from immich_ml.models import PetDetector

        self.model = PetDetector("yolox_x", min_score=0.01, cache_dir=Path("/cache/yolox_x"))

    def predict(self, image: Image.Image, threshold: float) -> list[dict[str, Any]]:
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=95)
        result = self.model.predict(buffer.getvalue())
        return [
            {
                "species": str(species),
                "score": float(score),
                "bbox": [float(value) for value in box],
                "mask": None,
            }
            for box, score, species in zip(result["boxes"], result["scores"], result["species"])
            if float(score) >= threshold
        ]


class RFDetrDetector(Detector):
    def __init__(self, variant: str) -> None:
        import torch
        from rfdetr import RFDETRSegLarge, RFDETRSegMedium

        model_class = {"rfdetr-seg-medium": RFDETRSegMedium, "rfdetr-seg-large": RFDETRSegLarge}[variant]
        self.model = model_class(device="cuda" if torch.cuda.is_available() else "cpu")

    def predict(self, image: Image.Image, threshold: float) -> list[dict[str, Any]]:
        detections = self.model.predict(image, threshold=threshold)
        names = detections.data.get("class_name")
        rows = []
        for index, (box, score, class_id) in enumerate(zip(detections.xyxy, detections.confidence, detections.class_id)):
            # RF-DETR 1.4 returns raw COCO category IDs (17 cat, 18 dog), not
            # the contiguous zero-based indices used by some COCO wrappers.
            species = str(names[index]).lower() if names is not None else {17: "cat", 18: "dog"}.get(int(class_id))
            if species not in {"cat", "dog"}:
                continue
            rows.append(
                {
                    "species": species,
                    "score": float(score),
                    "bbox": [float(value) for value in box],
                    "mask": detections.mask[index].astype(bool) if detections.mask is not None else None,
                }
            )
        return rows


class DFineDetector(Detector):
    def __init__(self, variant: str) -> None:
        import torch
        from transformers import AutoImageProcessor, DFineForObjectDetection

        repository = {
            "dfine-large": "ustc-community/dfine-large-coco",
            "dfine-xlarge": "ustc-community/dfine-xlarge-coco",
        }[variant]
        self.torch = torch
        self.processor = AutoImageProcessor.from_pretrained(repository)
        self.model = DFineForObjectDetection.from_pretrained(repository).to("cuda").eval()

    def predict(self, image: Image.Image, threshold: float) -> list[dict[str, Any]]:
        inputs = self.processor(images=image, return_tensors="pt").to(self.model.device)
        with self.torch.inference_mode():
            outputs = self.model(**inputs)
        result = self.processor.post_process_object_detection(
            outputs, target_sizes=[(image.height, image.width)], threshold=threshold
        )[0]
        rows = []
        for score, label, box in zip(result["scores"], result["labels"], result["boxes"]):
            species = self.model.config.id2label[int(label)].lower()
            if species in {"cat", "dog"}:
                rows.append({"species": species, "score": float(score), "bbox": box.tolist(), "mask": None})
        return rows


class UltralyticsDetector(Detector):
    def __init__(self, variant: str) -> None:
        from ultralytics import YOLO

        weights = {"yolo11x-seg": "yolo11x-seg.pt", "yolo26m-seg": "yolo26m-seg.pt"}[variant]
        self.model = YOLO(weights)

    def predict(self, image: Image.Image, threshold: float) -> list[dict[str, Any]]:
        result = self.model.predict(image, conf=threshold, verbose=False, device=0)[0]
        masks = result.masks.data.cpu().numpy() if result.masks is not None else None
        rows = []
        for index, (box, score, class_id) in enumerate(zip(result.boxes.xyxy, result.boxes.conf, result.boxes.cls)):
            species = result.names[int(class_id)].lower()
            if species not in {"cat", "dog"}:
                continue
            mask = masks[index].astype(bool) if masks is not None else None
            if mask is not None and mask.shape != (image.height, image.width):
                mask = np.asarray(Image.fromarray(mask).resize((image.width, image.height), Image.Resampling.NEAREST)).astype(bool)
            rows.append({"species": species, "score": float(score), "bbox": box.tolist(), "mask": mask})
        return rows


def load_detector(name: str) -> Detector:
    if name == "yolox-x":
        return ImmichYoloxDetector()
    if name.startswith("rfdetr-"):
        return RFDetrDetector(name)
    if name.startswith("dfine-"):
        return DFineDetector(name)
    if name.startswith("yolo"):
        return UltralyticsDetector(name)
    raise ValueError(f"Unknown detector: {name}")


def evaluate(args: argparse.Namespace) -> None:
    try:
        import torch
    except ImportError:
        torch = None

    data_dir = Path(args.data).resolve()
    records = json.loads((data_dir / "dataset.json").read_text(encoding="utf-8"))["images"]
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    summaries = []
    for model_name in [value.strip() for value in args.models.split(",") if value.strip()]:
        print(f"Loading {model_name}", flush=True)
        detector = load_detector(model_name)
        rows = []
        # Untimed warmup avoids charging model initialization and CUDA setup.
        warmup = Image.open(data_dir / records[0]["image"]).convert("RGB")
        detector.predict(warmup, args.threshold)
        if torch is not None and torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        for index, record in enumerate(records, start=1):
            image = Image.open(data_dir / record["image"]).convert("RGB")
            if torch is not None and torch.cuda.is_available():
                torch.cuda.synchronize()
            started = time.perf_counter()
            predictions = detector.predict(image, args.threshold)
            if torch is not None and torch.cuda.is_available():
                torch.cuda.synchronize()
            elapsed_ms = (time.perf_counter() - started) * 1000
            gt = record["annotations"][0]
            ranked = sorted(predictions, key=lambda item: bbox_iou(gt["bbox"], item["bbox"]), reverse=True)
            best = ranked[0] if ranked else None
            iou = bbox_iou(gt["bbox"], best["bbox"]) if best else 0.0
            gt_mask = np.asarray(Image.open(data_dir / gt["mask"])) > 0 if gt.get("mask") else None
            predicted_mask = best.get("mask") if best else None
            miou = mask_iou(gt_mask, predicted_mask) if gt_mask is not None and predicted_mask is not None else None
            rows.append(
                {
                    "id": record["id"],
                    "image": record["image"],
                    "expected": gt["species"],
                    "predicted": best["species"] if best else None,
                    "score": best["score"] if best else 0.0,
                    "bbox": best["bbox"] if best else None,
                    "groundTruthBox": gt["bbox"],
                    "boxIou": iou,
                    "maskIou": miou,
                    "localized": iou >= args.iou,
                    "correct": iou >= args.iou and best["species"] == gt["species"],
                    "predictionCount": len(predictions),
                    "latencyMs": elapsed_ms,
                }
            )
            if index % 25 == 0 or index == len(records):
                print(f"  {index}/{len(records)}", flush=True)
        localized = [row for row in rows if row["localized"]]
        correct = [row for row in rows if row["correct"]]
        mask_values = [row["maskIou"] for row in rows if row["maskIou"] is not None]
        confusion = Counter((row["expected"], row["predicted"] if row["localized"] else "missed") for row in rows)
        latency = sorted(row["latencyMs"] for row in rows)
        metrics = {
            "samples": len(rows),
            "localizationRecall": len(localized) / len(rows),
            "conditionalSpeciesAccuracy": len(correct) / len(localized) if localized else 0,
            "endToEndAccuracy": len(correct) / len(rows),
            "medianBoxIou": statistics.median(row["boxIou"] for row in rows),
            "medianMaskIou": statistics.median(mask_values) if mask_values else None,
            "latencyP50Ms": statistics.median(latency),
            "latencyP95Ms": latency[min(len(latency) - 1, round(len(latency) * 0.95))],
            "peakVramMb": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1)
            if torch is not None and torch.cuda.is_available()
            else 0,
            "confusion": {f"{key[0]}->{key[1]}": value for key, value in sorted(confusion.items())},
        }
        summaries.append({"model": model_name, "metrics": metrics})
        (output / f"{model_name}-predictions.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
        write_failure_report(output / f"{model_name}-failures.html", data_dir, model_name, rows)
        print(f"{model_name}: end-to-end {metrics['endToEndAccuracy']:.1%}", flush=True)
        del detector
        if torch is not None and torch.cuda.is_available():
            torch.cuda.empty_cache()
    (output / "summary.json").write_text(json.dumps(summaries, indent=2), encoding="utf-8")
    write_report(output / "report.html", summaries, records[0]["source"])


def _preview(path: Path, gt: list[float], predicted: list[float] | None) -> str:
    image = Image.open(path).convert("RGB")
    draw = ImageDraw.Draw(image)
    draw.rectangle(gt, outline="#34d399", width=max(3, image.width // 180))
    if predicted:
        draw.rectangle(predicted, outline="#60a5fa", width=max(3, image.width // 180))
    image.thumbnail((320, 260), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=76)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


def write_failure_report(path: Path, data_dir: Path, model: str, rows: Iterable[dict[str, Any]]) -> None:
    failures = [row for row in rows if not row["correct"]]
    cards = []
    for row in failures:
        cards.append(
            f'<article><img loading="lazy" src="{_preview(data_dir / row["image"], row["groundTruthBox"], row["bbox"])}">'
            f'<strong>{html.escape(row["id"])}</strong><span>{row["expected"]} → {row["predicted"] or "missed"} · IoU {row["boxIou"]:.2f}</span></article>'
        )
    path.write_text(
        "<!doctype html><meta charset=utf-8><style>:root{color-scheme:dark;font-family:system-ui;background:#0b0d10;color:#eee}body{padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}img{width:100%;height:220px;object-fit:contain;background:#151922;border-radius:12px}strong,span{display:block}span{color:#9ca3af}</style>"
        f"<h1>{html.escape(model)} failures</h1><p>{len(failures)} errors. Green = ground truth; blue = prediction.</p><div class=grid>{''.join(cards)}</div>",
        encoding="utf-8",
    )


def write_report(path: Path, summaries: list[dict[str, Any]], source: str) -> None:
    rows = []
    for summary in summaries:
        metrics = summary["metrics"]
        mask = "—" if metrics["medianMaskIou"] is None else f'{metrics["medianMaskIou"]:.3f}'
        rows.append(
            f'<tr><td>{html.escape(summary["model"])}</td><td>{metrics["localizationRecall"]:.1%}</td>'
            f'<td>{metrics["conditionalSpeciesAccuracy"]:.1%}</td><td>{metrics["endToEndAccuracy"]:.1%}</td>'
            f'<td>{metrics["medianBoxIou"]:.3f}</td><td>{mask}</td><td>{metrics["latencyP50Ms"]:.1f}</td>'
            f'<td>{metrics["latencyP95Ms"]:.1f}</td><td>{metrics["peakVramMb"]:.0f}</td></tr>'
        )
    caveat = (
        "Independent Oxford-IIIT Pet masks and species labels."
        if source == "oxford"
        else "Agreement with reviewed Immich sightings; stored boxes originated from the current pipeline, so this is not independent ground truth."
    )
    path.write_text(
        "<!doctype html><meta charset=utf-8><style>:root{color-scheme:dark;font-family:system-ui;background:#0b0d10;color:#eee}body{padding:28px}p{color:#9ca3af}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #293244;text-align:right}th:first-child,td:first-child{text-align:left}</style>"
        f"<h1>Pet detector benchmark</h1><p>{html.escape(caveat)}</p><table><thead><tr><th>Model</th><th>Localization</th><th>Species | localized</th><th>End-to-end</th><th>Median box IoU</th><th>Median mask IoU</th><th>p50 ms</th><th>p95 ms</th><th>Peak VRAM MB</th></tr></thead><tbody>{''.join(rows)}</tbody></table>",
        encoding="utf-8",
    )


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    oxford = commands.add_parser("build-oxford")
    oxford.add_argument("--source", required=True)
    oxford.add_argument("--output", required=True)
    oxford.add_argument("--split", default="test", choices=["test", "trainval"])
    oxford.add_argument("--per-species", type=int, default=200)
    oxford.add_argument("--seed", type=int, default=42)
    oxford.set_defaults(func=build_oxford)
    immich = commands.add_parser("export-immich")
    immich.add_argument("--url", required=True)
    immich.add_argument("--api-key")
    immich.add_argument("--access-token")
    immich.add_argument("--insecure", action="store_true", help="Disable TLS verification for a trusted SSH tunnel")
    immich.add_argument("--host-header", help="Override HTTP Host when using an SSH tunnel")
    immich.add_argument("--source-manifest", required=True)
    immich.add_argument("--output", required=True)
    immich.add_argument("--per-species", type=int, default=100)
    immich.add_argument("--seed", type=int, default=42)
    immich.set_defaults(func=export_immich)
    run = commands.add_parser("evaluate")
    run.add_argument("--data", required=True)
    run.add_argument("--output", required=True)
    run.add_argument("--models", default="yolox-x,rfdetr-seg-medium,dfine-large,yolo11x-seg")
    run.add_argument("--threshold", type=float, default=0.25)
    run.add_argument("--iou", type=float, default=0.5)
    run.set_defaults(func=evaluate)
    return root


if __name__ == "__main__":
    arguments = parser().parse_args()
    arguments.func(arguments)
