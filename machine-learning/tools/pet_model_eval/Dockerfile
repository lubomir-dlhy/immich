FROM nvcr.io/nvidia/pytorch:25.06-py3

WORKDIR /workspace/tool
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY requirements-detectors.txt .
RUN python -m pip install --no-cache-dir -r requirements-detectors.txt
COPY pet_eval.py detector_benchmark.py ./

ENTRYPOINT ["python", "/workspace/tool/pet_eval.py"]
