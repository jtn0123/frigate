# Bounded deployment benchmarks

Run each workload separately in an ephemeral container with production weights
mounted read-only. Never mount production `/state` or telemetry as output. Preserve
failed runs as evidence. These harnesses do not alter Frigate configuration.

- `speech.py`: Google FLEURS manifest with file hashes, original reference text,
  parallel English reference, language, and duration. Two CPU threads, int8, beam5,
  VAD, no previous-text conditioning, clean plus deterministic 10 dB white noise.
  The saved output supports resuming completed clips. The model stays loaded within
  a run, unlike the disposable production worker; cold load is reported separately.
- `score.py`: corpus-weighted Levenshtein WER/CER. NFKC, case folding, punctuation
  separation, and combining-mark removal are applied equally to references and
  predictions. Words are whitespace separated, so Persian word-boundary variants
  can increase WER; CER provides additional context. English edit rate is a lexical
  diagnostic, not a translation quality percentage.
- `capacity.py`: the production ROCm image's ONNX Runtime, two then four synthetic
  720p15 H264 streams, VAAPI decoding and one YOLO320 inference per frame at 5 FPS.
  It exercises shared GPU contention but excludes recording, motion processing,
  event handling, multiple detection regions, and additional audio arrivals.

Both runners wait for five healthy samples before allocating model work and stop
after three consecutive unhealthy checks (3-second intervals). Production stats
may repeat between checks. This is deliberately conservative. A healthy baseline
has detector time <=30 ms, skipped FPS <=0.5, and recent stats. Speech additionally
checks available memory during work. Use a hard external timeout and container
CPU/RAM limits as a second boundary. Verify that the temporary container is gone
following a timeout. A capacity abort means expansion is **not validated**.

Example commands from CT106, after copying scripts to `/tmp` and creating a
separate writable `/tmp/frigate-benchmark-followup` directory:

```sh
timeout 2400 docker run --rm --name frigate-speech-benchmark \
  --network host --cpus 2 --memory 7g --memory-swap 7g --read-only \
  --tmpfs /tmp:rw,size=512m \
  -v /opt/frigate/config/model_cache:/models:ro \
  -v /tmp/frigate-benchmark-speech.py:/bench.py:ro \
  -v /tmp/frigate-benchmark-followup:/output \
  local/frigate-audio-trial:20260912 python /bench.py \
  --root /models/multilingual-benchmark-20260912 --output /output \
  --model medium \
  --weights /models/whisper/models--Systran--faster-whisper-medium/snapshots/08e178d48790749d25932bbc082711ddcfdfbc4f
```

Use the Large-v3 snapshot from `../models.lock.json` for the separate Large trial.
Record the actual image ID, machine allocation, source/model revisions, camera
baseline, and all aborts alongside results. Do not compare CPU throughput from
local amd64 emulation on a Mac with native deployment CPU throughput.

Sources: [Google FLEURS](https://huggingface.co/datasets/google/fleurs), dataset
revision `70bb2e84b976b7e960aa89f1c648e09c59f894dd`, CC-BY-4.0. Current cached sample:
eight shared sentence IDs in Arabic and Persian, 16 recordings total. Arabic
speakers in this subset are all female and Persian speakers all male. It does not
represent Iraqi/Syrian dialects, multiple simultaneous speakers, or street-camera
acoustics. Noise augmentation does not remove those limitations.
