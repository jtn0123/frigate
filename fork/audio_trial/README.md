# Doorbell audio trial

An isolated CPU companion service. It reads Frigate's settled review events and
recordings, processes doorbell speech and sounds automatically, and saves results
in its own SQLite database. It never changes Frigate descriptions, configuration,
or notifications. No GPU access, camera credentials, or new listening ports.

## Pipeline

1. Reuse Frigate audio/person review events; ignore car-only activity.
2. Wait 20 seconds after an event closes for recordings to settle.
3. Analyze at most 30 seconds per job, with two seconds of overlap between chunks.
4. Use speech activity detection before Whisper Medium CPU int8. Save the original
   transcript and English translation when the detected language is not English.
5. Use CLAP for three candidate sound labels. Similarities are not probabilities.
6. Try cached Large-v3 only for empty transcripts despite speech or excessive
   repetition, at most twice per hour and only with sufficient memory. Preserve
   both outputs; a second opinion does not establish correctness.

One inference process runs at a time across all configured cameras. Each process
exits to release its models. This costs extra startup time but keeps idle memory
low and prevents Medium and Large from remaining resident together. NLLB is not
part of this initial trial.

## Limits and visibility

- Doorbell only. Camera order sets priority if the trial is later expanded.
- Maximum 20 pending jobs; expire work older than 10 minutes. Recordings remain
  under Frigate retention. Results and failure records expire after seven days.
- Delay new work above 30 ms detector inference or 0.5 skipped fps on any camera.
  Terminate analysis after three consecutive busy checks, checked every three
  seconds plus API response time. Failed jobs retry once.
- Reserve 5 GiB for Medium and 7.5 GiB for Large before starting. Observe the LXC
  parent cgroup usage against the Proxmox-verified 20 GiB limit, not the worker's
  Docker limit. Update `PARENT_MEMORY_LIMIT_BYTES` if CT 106 is resized. Its ancestor
  limit is hidden, and lxcfs renders meminfo for the calling Docker process even
  when bind-mounted, so that file cannot supply the parent limit.
- Docker caps the worker at three CPU equivalents, 7 GiB RAM, no swap. Model
  threads use two cores. Temporary clips are bounded and removed after analysis.
- `state/status.json` contains the latest 100 jobs and outputs. Full seven-day
  results are in `state/queue.sqlite`. Logs exclude transcripts and credentials.
- Audio results are not integrated into Frigate's event view. This is an operator-reviewed trial;
  results do not automatically become alerts or overwrite existing descriptions.

## Model telemetry

The worker now publishes a separate, transcript-free metrics file at
`/opt/frigate/config/model_cache/audio-trial-telemetry/models.json`. Frigate's new
admin-only `/api/ai/models` endpoint and System > AI Models tab consume it when
the corresponding Frigate image is released. The worker's metrics publisher can
be deployed before that image; it adds no network listener.

Metrics include model disk size, processing/loading state, current process CPU
and RSS while a model is executing, sampled peak process RSS, last stage latency,
load time, and aggregate queue counters. Inactive models show zero current
allocation. Runtime overhead and allocator retention are included, so these are
process measurements rather than exact model-only allocations. Samples may miss
very short stages. Last/peak values persist between jobs; current values reset
after the inference subprocess exits. The UI marks data stale after 90 seconds.

Each smoke run now writes a separate `state/validation-<timestamp>/report.json`
and exercises the metrics publisher along with recorded speech and noise clips.

The trial depends on Frigate generating an audio or person review event. It will
miss sounds outside those triggers and waits for long-running events to close.
Speech detection can miss quiet/distant speech or mistake noise for speech.
Plausible but incorrect wording can pass the retry checks. No universal confidence
score is claimed. Chunk boundaries may duplicate words. A memory-deferred Large
retry is recorded but not scheduled again automatically in this first version.

## Deploy on CT 106

Copy this directory to `/opt/frigate/audio-trial` and run:

```sh
install -d -o 1000 -g 1000 state /opt/frigate/config/model_cache/audio-trial-telemetry
# For an existing trial, transfer only its own writable state and telemetry.
chown -R 1000:1000 state /opt/frigate/config/model_cache/audio-trial-telemetry
docker compose build
docker compose run --rm --no-deps audio-trial python -m unittest discover -v
docker compose up -d
docker compose logs --tail 20
```

The image runs as UID/GID 1000. Its state and telemetry directories must be
writable by that identity; cached model files must be readable.

The Compose file mounts existing cached models read-only from
`/opt/frigate/config/model_cache`. Medium/Large must already exist in its
`whisper` Hugging Face cache. CLAP is pinned to the benchmark snapshot in Compose.
Downloads are disabled at runtime. Do not point it at an arbitrary/unbounded
cgroup hierarchy; the mounts assume this Proxmox LXC deployment.

Check `state/status.json` for paused reasons and results. Restarting the service
retains the queue. To roll back: `docker compose down`. This stops only the trial;
Frigate and its recordings continue normally. Keep the state directory if results
are wanted, and keep models on disk for later use.

## Verification

```sh
python3 -u -m unittest discover -s fork/audio_trial -v
uvx ruff check fork/audio_trial
uvx ruff format --check fork/audio_trial
```

Queue/worker tests cover recovery, deduplication, scope, capacity, stable chunk
identity, aging, bounded retries, memory checks, preserving Medium results after
a failed Large retry, and cancelling inference when camera health is unavailable.
Real hardware smoke tests are also required before leaving the trial running.
These tests do not establish capacity for additional live camera streams.
