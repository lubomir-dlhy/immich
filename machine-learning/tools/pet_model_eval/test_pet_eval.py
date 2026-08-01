import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image

from pet_eval import (
    Sample,
    crop_sighting,
    evaluate_embeddings,
    identity_label,
    load_oxford_species_samples,
    species_metrics,
    zero_shot_metrics,
)


def sample(sample_id: str, pet_id: str, pet_name: str, asset_id: str) -> Sample:
    return Sample(
        sample_id=sample_id,
        pet_id=pet_id,
        pet_name=pet_name,
        species="dog",
        asset_id=asset_id,
        sighting_id=sample_id,
        track_id=sample_id,
        frame_timestamp_ms=0,
        source_type="IMAGE",
        crop_path=f"{sample_id}.jpg",
        detection_score=0.9,
    )


class PetEvaluationTest(unittest.TestCase):
    def test_crop_scales_stored_box_to_downloaded_frame(self) -> None:
        frame = Image.new("RGB", (500, 250))
        crop = crop_sighting(
            frame,
            {
                "imageWidth": 1000,
                "imageHeight": 500,
                "boundingBoxX1": 200,
                "boundingBoxY1": 100,
                "boundingBoxX2": 600,
                "boundingBoxY2": 400,
            },
            padding=0,
        )
        self.assertEqual(crop.size, (200, 150))

    def test_duplicate_named_clusters_are_one_identity(self) -> None:
        first = sample("a", "cluster-1", "Teo", "asset-1")
        second = sample("b", "cluster-2", " teo ", "asset-2")
        self.assertEqual(identity_label(first), identity_label(second))

    def test_same_asset_is_excluded_from_nearest_neighbor(self) -> None:
        samples = [
            sample("a1", "a", "Miki", "shared"),
            sample("a2", "a", "Miki", "other-a"),
            sample("b1", "b", "Endy", "shared"),
            sample("b2", "b", "Endy", "other-b"),
        ]
        embeddings = np.asarray([[1, 0], [1, 0], [0.99, 0.01], [0, 1]], dtype=np.float32)
        embeddings /= np.linalg.norm(embeddings, axis=1, keepdims=True)
        metrics, results = evaluate_embeddings(samples, embeddings)
        self.assertEqual(metrics["queries"], 4)
        self.assertTrue(next(result for result in results if result["sampleId"] == "a1")["top1"])

    def test_oxford_species_parser_uses_official_species_column(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "annotations").mkdir()
            (root / "images").mkdir()
            (root / "annotations" / "test.txt").write_text(
                "Abyssinian_1 1 1 1\namerican_bulldog_1 2 2 1\n",
                encoding="utf-8",
            )
            for image_id in ("Abyssinian_1", "american_bulldog_1"):
                Image.new("RGB", (2, 2)).save(root / "images" / f"{image_id}.jpg")
            rows = load_oxford_species_samples(root, "test", 1, 42)
            self.assertEqual({species for _, species in rows}, {"cat", "dog"})

    def test_species_metrics_separate_misses_from_wrong_species(self) -> None:
        rows = [
            {"expected": "cat", "predicted": "cat", "score": 0.9},
            {"expected": "cat", "predicted": "dog", "score": 0.8},
            {"expected": "dog", "predicted": "dog", "score": 0.4},
            {"expected": "dog", "predicted": None, "score": 0.0},
        ]
        metrics = species_metrics(rows, 0.65)
        self.assertEqual(metrics["confusion"]["cat"]["dog"], 1)
        self.assertEqual(metrics["confusion"]["dog"]["missed"], 2)
        self.assertEqual(metrics["conditionalAccuracy"], 0.5)
        self.assertEqual(metrics["balancedEndToEndAccuracy"], 0.25)

    def test_zero_shot_metrics_balance_species(self) -> None:
        rows = [
            {"expected": "cat", "predicted": "cat", "margin": 0.2},
            {"expected": "cat", "predicted": "dog", "margin": 0.1},
            {"expected": "dog", "predicted": "dog", "margin": 0.3},
        ]
        metrics = zero_shot_metrics(rows)
        self.assertEqual(metrics["accuracy"], 2 / 3)
        self.assertEqual(metrics["balancedAccuracy"], 0.75)


if __name__ == "__main__":
    unittest.main()
