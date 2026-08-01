# Pet embedding model evaluation

This tool exports a read-only evaluation set from named Immich pets and compares
pet-specific embedding models without changing production embeddings or clusters.

The split is performed by **asset**, not by crop. Frames from the same video can
therefore never appear in both the reference gallery and the query set.
Named Immich clusters with the same normalized name and species are treated as
one identity, which handles duplicate clusters such as the two current `Teo`
records without scoring one as a false match for the other.

## 1. Export named pet crops

Create a temporary Immich API key for the account being evaluated, then run:

```bash
export IMMICH_API_KEY='...'
python pet_eval.py export \
  --url https://gallery.lubomirdlhy.sk \
  --output ./data \
  --max-samples-per-pet 120 \
  --max-samples-per-asset 4
```

The exporter downloads preview frames, applies the exact stored pet bounding
box with the same 8% padding used by Immich ML, and writes `data/manifest.jsonl`.
It only reads `/api/pets`, pet search results, asset pet annotations, and
thumbnail endpoints.

For a species-label review that includes automatic clusters without names, add
`--include-unnamed --species cat`. Unnamed clusters receive a stable display
label derived from their cluster ID; they must not be treated as verified
identity labels without manual review.

## 2. Preview labels

```bash
python pet_eval.py preview --data ./data --output ./results/dataset-preview.html
```

The preview is important: model results are meaningless if a named cluster
still contains a different dog. Exclude a bad crop by setting `include` to
`false` in `manifest.jsonl`, or correct it in Immich and export again.

## 3. Compare models on the GX10

```bash
docker build -t immich-pet-eval -f Dockerfile .
docker run --rm --gpus all \
  -v "$PWD/data:/workspace/data:ro" \
  -v "$PWD/results:/workspace/results" \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  immich-pet-eval evaluate \
  --data /workspace/data \
  --output /workspace/results \
  --models avito-dinov2-small,avito-zer0int-clip-l,avito-siglip2-base
```

Available Hugging Face models:

- `avito-dinov2-small` — 384 dimensions, fast baseline.
- `avito-zer0int-clip-l` — 768 dimensions, best practical published result.
- `avito-siglip2-base` — 768 dimensions.
- `avito-siglip2-giant` — 1536 dimensions, accuracy-first and expensive.

To evaluate the current Immich ONNX model too, run the evaluator in an
environment that already has a compatible ONNX Runtime build, mount the model,
and add:

```bash
--current-onnx /models/model.onnx --models current,...
```

The GX10 is ARM64 and PyPI does not currently provide an `onnxruntime-gpu`
wheel for that platform. The deployed Immich machine-learning image already
contains a working ARM64 runtime, so use that image for the current-model run.

The alternative two-stage flow is:

```bash
python pet_eval.py encode-current \
  --data ./data \
  --current-onnx ./model.onnx \
  --output ./results/current-embeddings.npy

python pet_eval.py evaluate \
  --data ./data \
  --output ./results \
  --models current \
  --current-embeddings ./results/current-embeddings.npy
```

Each model produces embeddings, metrics, nearest-neighbor errors, a two-
dimensional UMAP projection, and an HTML report. No result is written back to
Immich.

## Metrics

- **Top-1 / Top-3:** whether the correct named pet appears among nearest pets.
- **Macro top-1:** top-1 averaged per pet so Miki's large cluster cannot hide
  poor results on smaller pets.
- **False-match rate:** queries whose closest result is another pet.
- **Margin:** distance to the best wrong pet minus distance to the correct pet.
- **EER:** verification error where false accepts and false rejects are equal.

Models should be compared on the same manifest and split. Public benchmark
numbers are not interchangeable with these library-specific measurements.

## Full detector and segmentation benchmark

`detector_benchmark.py` compares complete detection pipelines, including
localization and (where available) masks. Build an independently labeled
Oxford dataset and a reviewed Immich-frame dataset:

```bash
python detector_benchmark.py build-oxford \
  --source ./oxford-pets --output ./detector-data/oxford --per-species 200

python detector_benchmark.py export-immich \
  --url https://gallery.lubomirdlhy.sk \
  --source-manifest ./data/source-manifest.json \
  --output ./detector-data/immich --per-species 100
```

Then evaluate the same candidates and threshold on the GX10:

```bash
python detector_benchmark.py evaluate \
  --data ./detector-data/oxford --output ./detector-results/oxford \
  --models rfdetr-seg-medium,rfdetr-seg-large,dfine-large,yolo11x-seg
```

Oxford provides independent masks and species labels. The Immich track measures
agreement with manually reviewed stored sightings, but its bounding boxes were
originally produced by the deployed pipeline; it is useful for domain coverage,
not as an independent detector-accuracy estimate. Reports include localization
recall at IoU 0.5, conditional species accuracy, end-to-end accuracy, median box
and mask IoU, p50/p95 GX10 latency, peak VRAM, and a visual failure gallery.

## Tests

```bash
python -m unittest test_pet_eval.py
```

The tests cover bounding-box scaling, duplicate named clusters, and the
asset-level leakage guard, plus the Oxford species parser and species metrics.

## Cat/dog detection benchmark

Identity embeddings and species detection are separate stages. To evaluate the
deployed YOLOX detector with independently labeled cats and dogs, download the
[Oxford-IIIT Pet dataset](https://robots.ox.ac.uk/~vgg/data/pets/):

```bash
mkdir -p ./oxford-pets
curl -L https://www.robots.ox.ac.uk/~vgg/data/pets/data/images.tar.gz | tar -xz -C ./oxford-pets
curl -L https://www.robots.ox.ac.uk/~vgg/data/pets/data/annotations.tar.gz | tar -xz -C ./oxford-pets
```

Run the evaluator inside the Immich machine-learning image so it uses the exact
deployed ONNX Runtime and detector implementation:

```bash
python pet_eval.py evaluate-species \
  --data ./oxford-pets \
  --output ./results/species \
  --cache /cache/pet-recognition \
  --models yolox_s,yolox_m,yolox_x \
  --thresholds 0.25,0.50,0.65 \
  --per-species 200
```

The report separates detection recall, species accuracy among detected pets,
and end-to-end accuracy. This prevents a high cat/dog accuracy number from
hiding pets that the detector missed entirely. A separate failure-preview HTML
shows every wrong-species result and miss at the highest requested threshold,
including the best raw detection bounding box when one exists.

Use `--per-species 0` for the complete official split. The report includes a
balanced end-to-end score so the larger number of dog breeds cannot outweigh
cat performance.

## Cat/dog classification after detection

Vision-language identity encoders can also be tested as zero-shot species
classifiers on already-localized pet crops:

```bash
python pet_eval.py evaluate-zero-shot-species \
  --data ./oxford-pets \
  --output ./results/species-classification \
  --models google-siglip2-base,avito-zer0int-clip-l,avito-siglip2-base,avito-siglip2-giant
```

This track does not measure whether a pet was found or whether its bounding box
is correct. It only measures cat-versus-dog classification once a crop exists.
