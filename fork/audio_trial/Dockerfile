FROM python:3.11-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84
# Immutable Debian snapshot fixes transitive OS package versions as well.
RUN rm /etc/apt/sources.list.d/debian.sources \
    && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260912T000000Z bookworm main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260912T000000Z bookworm-security main\n' > /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.lock ./
RUN pip install --require-hashes --only-binary :all: --no-cache-dir \
    --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.lock \
    && pip check
COPY *.py labels.json models.lock.json ./
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1 \
    XDG_CACHE_HOME=/tmp/cache NUMBA_CACHE_DIR=/tmp/numba
USER 1000:1000
CMD ["python", "worker.py"]
