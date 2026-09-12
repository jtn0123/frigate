FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --only-binary :all: --no-cache-dir torch==2.8.0+cpu --index-url https://download.pytorch.org/whl/cpu \
    && pip install --only-binary :all: --no-cache-dir ctranslate2==4.6.0 faster-whisper==1.1.1 \
        librosa==0.11.0 numpy==1.26.4 psutil==7.0.0 scipy==1.16.3 transformers==4.57.6
WORKDIR /app
COPY *.py labels.json ./
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1 \
    XDG_CACHE_HOME=/tmp/cache NUMBA_CACHE_DIR=/tmp/numba
USER 1000:1000
CMD ["python", "worker.py"]
