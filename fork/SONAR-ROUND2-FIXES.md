# Sonar round 2: 100 additional fixes

Generated from the live `next` issue inventory retrieved September 12, 2026.
Each row is a distinct Sonar issue, excluded from the first round's 15.
Rows 16-114 preserve caught-exception tracebacks (rule `python:S8572`).
Row 115 retains and stops the replay watchdog (rule `python:S7502`).

Focused regression tests reproduced missing tracebacks and incomplete watchdog
shutdown before the changes, and pass afterward. An AST comparison verifies
all 99 logging changes preserve their arguments and surrounding control flow.
Hardware-specific runtime paths are source-verified; no physical device testing
is claimed. Sonar closure remains pending a scan of the delivered revision.

Final gate: **1,059 backend tests passed**, mypy passed for 357 source files,
Ruff passed for all 39 changed/new Python files, and the API-spec and workflow
checks passed. Changes remain local on `fix/sonar-priority`.

| Running # | Sonar issue | Source after fix | Diagnostic context |
|---:|---|---|---|
| 16 | [AaCOHyqH9tFduPng0961](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng0961) | `frigate/util/camera_cleanup.py:138` | Failed to remove snapshot %s: %s |
| 17 | [AaCOHyqH9tFduPng0962](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng0962) | `frigate/util/camera_cleanup.py:144` | Failed to remove snapshot %s: %s |
| 18 | [AaCOHyqH9tFduPng096q](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng096q) | `frigate/util/camera_cleanup.py:41` | Failed to delete events for camera %s: %s |
| 19 | [AaCOHyqH9tFduPng096r](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng096r) | `frigate/util/camera_cleanup.py:48` | Failed to delete timeline for camera %s: %s |
| 20 | [AaCOHyqH9tFduPng096s](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng096s) | `frigate/util/camera_cleanup.py:55` | Failed to delete recordings for camera %s: %s |
| 21 | [AaCOHyqH9tFduPng096t](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng096t) | `frigate/util/camera_cleanup.py:64` | Failed to delete review segments for camera %s: %s |
| 22 | [AaCOHyqH9tFduPng096u](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng096u) | `frigate/util/camera_cleanup.py:73` | Failed to delete previews for camera %s: %s |
| 23 | [AaCOHyqH9tFduPng096v](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng096v) | `frigate/util/camera_cleanup.py:80` | Failed to delete regions for camera %s: %s |
| 24 | [AaCOHyqH9tFduPng096w](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng096w) | `frigate/util/camera_cleanup.py:87` | Failed to delete triggers for camera %s: %s |
| 25 | [AaCOHyqH9tFduPng096x](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng096x) | `frigate/util/camera_cleanup.py:102` | Failed to delete exports for camera %s: %s |
| 26 | [AaCOHyqH9tFduPng096z](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng096z) | `frigate/util/camera_cleanup.py:131` | Failed to remove %s: %s |
| 27 | [AaCOHyqH9tFduPng0960](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng0960) | `frigate/util/camera_cleanup.py:150` | Failed to remove snapshot %s: %s |
| 28 | [AaCOHyqH9tFduPng0963](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng0963) | `frigate/util/camera_cleanup.py:159` | Failed to remove review thumbnail %s: %s |
| 29 | [AaCOHyqH9tFduPng0964](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqH9tFduPng0964) | `frigate/util/camera_cleanup.py:169` | Failed to remove export file %s: %s |
| 30 | [AaCOHylS9tFduPng094m](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHylS9tFduPng094m) | `frigate/util/downloader.py:95` | Error downloading model: {value} |
| 31 | [AaCOHyZo9tFduPng090K](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyZo9tFduPng090K) | `frigate/api/camera.py:119` | Error communicating with go2rtc: %s |
| 32 | [AaCOHyo89tFduPng096c](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyo89tFduPng096c) | `frigate/util/services.py:1157` | Keyframe probe failed: %s |
| 33 | [AaCOHyUb9tFduPng09zG](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyUb9tFduPng09zG) | `frigate/genai/__init__.py:166` | Failed to parse review description JSON: %s |
| 34 | [AaCOHyUb9tFduPng09zH](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyUb9tFduPng09zH) | `frigate/genai/__init__.py:183` | Failed to parse review description as the response did not match expected format. {value} |
| 35 | [AaCOHyUb9tFduPng09zI](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyUb9tFduPng09zI) | `frigate/genai/__init__.py:201` | Failed to post-process review metadata: {value} |
| 36 | [AaCOHymp9tFduPng095t](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095t) | `frigate/util/media.py:829` | Failed to write orphan report to %s: %s |
| 37 | [AaCOHydM9tFduPng0916](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHydM9tFduPng0916) | `frigate/api/app.py:803` | Error applying config in-memory: {value} |
| 38 | [AaCOHybJ9tFduPng090-](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHybJ9tFduPng090-) | `frigate/api/debug_replay.py:293` | Error stopping replay: %s |
| 39 | [AaCOHyyp9tFduPng099V](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyyp9tFduPng099V) | `frigate/debug_replay.py:318` | Failed to remove replay cache: %s |
| 40 | [AaCOHyyp9tFduPng099X](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyyp9tFduPng099X) | `frigate/debug_replay.py:361` | Failed to remove replay cache directory: %s |
| 41 | [AaCOHybi9tFduPng091Q](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHybi9tFduPng091Q) | `frigate/api/record.py:449` | Failed to delete recording file {value}: {value} |
| 42 | [AaCOHyBn9tFduPng09xS](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyBn9tFduPng09xS) | `frigate/output/preview.py:111` | Error searching for most recent preview frame: {value} |
| 43 | [AaCOHymp9tFduPng095V](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095V) | `frigate/util/media.py:184` | Database error during recordings db cleanup: {value} |
| 44 | [AaCOHymp9tFduPng095Y](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095Y) | `frigate/util/media.py:249` | Failed to delete {value}: {value} |
| 45 | [AaCOHymp9tFduPng095Z](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095Z) | `frigate/util/media.py:254` | Error syncing recordings: {value} |
| 46 | [AaCOHymp9tFduPng095c](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095c) | `frigate/util/media.py:339` | Failed to delete {value}: {value} |
| 47 | [AaCOHymp9tFduPng095d](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095d) | `frigate/util/media.py:342` | Error syncing event snapshots: {value} |
| 48 | [AaCOHymp9tFduPng095g](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095g) | `frigate/util/media.py:435` | Failed to delete {value}: {value} |
| 49 | [AaCOHymp9tFduPng095h](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095h) | `frigate/util/media.py:438` | Error syncing event thumbnails: {value} |
| 50 | [AaCOHymp9tFduPng095k](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095k) | `frigate/util/media.py:515` | Failed to delete {value}: {value} |
| 51 | [AaCOHymp9tFduPng095l](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095l) | `frigate/util/media.py:518` | Error syncing review thumbnails: {value} |
| 52 | [AaCOHymp9tFduPng095o](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095o) | `frigate/util/media.py:593` | Failed to delete {value}: {value} |
| 53 | [AaCOHymp9tFduPng095p](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095p) | `frigate/util/media.py:596` | Error syncing previews: {value} |
| 54 | [AaCOHymp9tFduPng095r](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095r) | `frigate/util/media.py:685` | Failed to delete {value}: {value} |
| 55 | [AaCOHymp9tFduPng095s](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymp9tFduPng095s) | `frigate/util/media.py:688` | Error syncing exports: {value} |
| 56 | [AaCOHyth9tFduPng097r](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyth9tFduPng097r) | `frigate/comms/dispatcher.py:860` | Invalid PTZ command {value}: {value} |
| 57 | [AaCOHyCK9tFduPng09xn](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyCK9tFduPng09xn) | `frigate/detectors/plugins/memryx.py:875` | Error during MemryX shutdown: {value} |
| 58 | [AaCOHy0P9tFduPng099z](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHy0P9tFduPng099z) | `frigate/object_detection/base.py:313` | Error during async detector shutdown: {value} |
| 59 | [AaCOHyOh9tFduPng09yY](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyOh9tFduPng09yY) | `frigate/detectors/detection_runners.py:462` | Error during OpenVINO inference: {value} |
| 60 | [AaCOHymV9tFduPng094_](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymV9tFduPng094_) | `frigate/util/classification.py:66` | Failed to write training metadata for {value}: {value} |
| 61 | [AaCOHymV9tFduPng095A](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymV9tFduPng095A) | `frigate/util/classification.py:91` | Failed to read training metadata for {value}: {value} |
| 62 | [AaCOHymV9tFduPng095B](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymV9tFduPng095B) | `frigate/util/classification.py:125` | Failed to count dataset images for {value}: {value} |
| 63 | [AaCOHyc99tFduPng091v](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyc99tFduPng091v) | `frigate/api/classification.py:1099` | Error renaming category: {value} |
| 64 | [AaCOHylc9tFduPng094o](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHylc9tFduPng094o) | `frigate/util/file.py:350` | Error cleaning up stale lock: {value} |
| 65 | [AaCOHylc9tFduPng094p](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHylc9tFduPng094p) | `frigate/util/file.py:420` | Error acquiring lock: {value} |
| 66 | [AaCOHylc9tFduPng094q](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHylc9tFduPng094q) | `frigate/util/file.py:458` | Error releasing lock: {value} |
| 67 | [AaCOHyeG9tFduPng092h](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyeG9tFduPng092h) | `frigate/data_processing/post/review_descriptions.py:476` | Error extracting frame from recording for {value} at {value}: {value} |
| 68 | [AaCOHymV9tFduPng095E](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymV9tFduPng095E) | `frigate/util/classification.py:419` | Failed to save image {value}: {value} |
| 69 | [AaCOHymV9tFduPng095M](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHymV9tFduPng095M) | `frigate/util/classification.py:772` | Failed to save image {value}: {value} |
| 70 | [AaCOHyZo9tFduPng090L](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyZo9tFduPng090L) | `frigate/api/camera.py:204` | Error communicating with go2rtc: {value} |
| 71 | [AaCOHyZo9tFduPng090M](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyZo9tFduPng090M) | `frigate/api/camera.py:239` | Error communicating with go2rtc: {value} |
| 72 | [AaCOHynm9tFduPng0950](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHynm9tFduPng0950) | `frigate/util/rknn_converter.py:213` | Failed to create temporary ONNX copy: {value} |
| 73 | [AaCOHyFc9tFduPng09xw](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyFc9tFduPng09xw) | `frigate/detectors/plugins/synaptics.py:58` | Synap1680 setup has failed: {value} |
| 74 | [AaCOHyFc9tFduPng09xx](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyFc9tFduPng09xx) | `frigate/detectors/plugins/synaptics.py:61` | Failed to init Synap NPU: {value} |
| 75 | [AaCOHyJ09tFduPng09x6](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyJ09tFduPng09x6) | `frigate/detectors/plugins/zmq_ipc.py:125` | Failed to initialize model: {value} |
| 76 | [AaCOHyJ09tFduPng09x7](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyJ09tFduPng09x7) | `frigate/detectors/plugins/zmq_ipc.py:171` | Failed to check and transfer model: {value} |
| 77 | [AaCOHyJ09tFduPng09x8](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyJ09tFduPng09x8) | `frigate/detectors/plugins/zmq_ipc.py:208` | Failed to check model availability: {value} |
| 78 | [AaCOHyJ09tFduPng09x9](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyJ09tFduPng09x9) | `frigate/detectors/plugins/zmq_ipc.py:265` | Failed to send model data: {value} |
| 79 | [AaCOHyOh9tFduPng09yZ](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyOh9tFduPng09yZ) | `frigate/detectors/detection_runners.py:504` | Error loading RKNN model: {value} |
| 80 | [AaCOHyOh9tFduPng09yb](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyOh9tFduPng09yb) | `frigate/detectors/detection_runners.py:575` | Error during RKNN inference: {value} |
| 81 | [AaCOHyCK9tFduPng09xj](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyCK9tFduPng09xj) | `frigate/detectors/plugins/memryx.py:190` | Failed to initialize MemryX model: {value} |
| 82 | [AaCOHynm9tFduPng095x](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHynm9tFduPng095x) | `frigate/util/rknn_converter.py:137` | RKNN toolkit not found. Please ensure it's installed. {value} |
| 83 | [AaCOHynm9tFduPng095w](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHynm9tFduPng095w) | `frigate/util/rknn_converter.py:125` | Failed to install PyTorch: {value} |
| 84 | [AaCOHynm9tFduPng0951](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHynm9tFduPng0951) | `frigate/util/rknn_converter.py:254` | Error during RKNN conversion: {value} |
| 85 | [AaCOHyUb9tFduPng09zJ](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyUb9tFduPng09zJ) | `frigate/genai/__init__.py:254` | Invalid key in GenAI prompt: {value} |
| 86 | [AaCOHyJ09tFduPng09x-](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyJ09tFduPng09x-) | `frigate/detectors/plugins/zmq_ipc.py:297` | ZMQ detector failed to decode response: {value} |
| 87 | [AaCOHyJ09tFduPng09x_](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyJ09tFduPng09x_) | `frigate/detectors/plugins/zmq_ipc.py:328` | ZMQ detector ZMQError: {value}; resetting socket |
| 88 | [AaCOHyJ09tFduPng09yA](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyJ09tFduPng09yA) | `frigate/detectors/plugins/zmq_ipc.py:336` | ZMQ detector unexpected error: {value} |
| 89 | [AaCOHyfd9tFduPng093C](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyfd9tFduPng093C) | `frigate/data_processing/common/audio_transcription/model.py:83` | Failed to download {value}: {value} |
| 90 | [AaCOHydy9tFduPng092Y](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHydy9tFduPng092Y) | `frigate/data_processing/post/audio_transcription.py:69` | Failed to initialize recordings audio transcription: {value} |
| 91 | [AaCOHydy9tFduPng092Z](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHydy9tFduPng092Z) | `frigate/data_processing/post/audio_transcription.py:145` | Error in audio transcription post-processing: {value} |
| 92 | [AaCOHydy9tFduPng092a](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHydy9tFduPng092a) | `frigate/data_processing/post/audio_transcription.py:180` | Error transcribing audio: {value} |
| 93 | [AaCOHygC9tFduPng093N](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHygC9tFduPng093N) | `frigate/data_processing/real_time/audio_transcription.py:74` | Failed to initialize live streaming audio transcription: {value} |
| 94 | [AaCOHygC9tFduPng093P](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHygC9tFduPng093P) | `frigate/data_processing/real_time/audio_transcription.py:140` | Error processing audio stream: {value} |
| 95 | [AaCOHygC9tFduPng093R](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHygC9tFduPng093R) | `frigate/data_processing/real_time/audio_transcription.py:191` | Error processing audio in thread: {value} |
| 96 | [AaCOHyga9tFduPng093m](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyga9tFduPng093m) | `frigate/data_processing/real_time/whisper_online.py:1104` | assertion error: {value} |
| 97 | [AaCOHyga9tFduPng093o](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyga9tFduPng093o) | `frigate/data_processing/real_time/whisper_online.py:1116` | assertion error: {value} |
| 98 | [AaCOHyga9tFduPng093q](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyga9tFduPng093q) | `frigate/data_processing/real_time/whisper_online.py:1148` | assertion error: {value} |
| 99 | [AaCOHyVP9tFduPng09ze](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyVP9tFduPng09ze) | `frigate/embeddings/embeddings.py:608` | Failed to write thumbnail for trigger with data {value} in {value}: {value} |
| 100 | [AaCOHyVP9tFduPng09zf](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyVP9tFduPng09zf) | `frigate/embeddings/embeddings.py:620` | Failed to delete thumbnail for trigger with data {value} in {value}: {value} |
| 101 | [AaCOHyVP9tFduPng09zh](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyVP9tFduPng09zh) | `frigate/embeddings/embeddings.py:655` | Failed to read thumbnail for trigger {value} with ID {value}: {value} |
| 102 | [AaCOHyqY9tFduPng0968](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyqY9tFduPng0968) | `frigate/util/audio.py:109` | Error extracting audio from recordings: {value} |
| 103 | [AaCOHyUm9tFduPng09zW](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyUm9tFduPng09zW) | `frigate/embeddings/__init__.py:92` | Failed to clear corrupted stats file: {value} |
| 104 | [AaCOHyuJ9tFduPng097z](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyuJ9tFduPng097z) | `frigate/ptz/onvif.py:87` | Onvif event loop terminated unexpectedly: {value} |
| 105 | [AaCOHyuJ9tFduPng0979](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyuJ9tFduPng0979) | `frigate/ptz/onvif.py:869` | Error executing command {value} for camera {value}: {value} |
| 106 | [AaCOHyuJ9tFduPng098E](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyuJ9tFduPng098E) | `frigate/ptz/onvif.py:1102` | Error during loop cleanup: {value} |
| 107 | [AaCOHyuJ9tFduPng0973](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyuJ9tFduPng0973) | `frigate/ptz/onvif.py:189` | Onvif connection failed for {value}: {value} |
| 108 | [AaCOHyuJ9tFduPng0971](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyuJ9tFduPng0971) | `frigate/ptz/onvif.py:173` | Failed to create ONVIF camera instance for {value}: {value} |
| 109 | [AaCOHyuJ9tFduPng097_](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyuJ9tFduPng097_) | `frigate/ptz/onvif.py:932` | Error during ONVIF initialization for {value}: {value} |
| 110 | [AaCOHyKG9tFduPng09yC](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyKG9tFduPng09yC) | `frigate/detectors/plugins/hailo8l.py:73` | Inference error: {value} |
| 111 | [AaCOHyKG9tFduPng09yD](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyKG9tFduPng09yD) | `frigate/detectors/plugins/hailo8l.py:264` | [INIT] Failed to initialize HailoAsyncInference: {value} |
| 112 | [AaCOHyKG9tFduPng09yG](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyKG9tFduPng09yG) | `frigate/detectors/plugins/hailo8l.py:402` | Failed to close Hailo device: {value} |
| 113 | [AaCOHywM9tFduPng099E](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHywM9tFduPng099E) | `frigate/stats/prometheus.py:517` | Error updating metrics: {value} |
| 114 | [AaCOHysO9tFduPng097V](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHysO9tFduPng097V) | `frigate/comms/webpush.py:339` | Error processing notification: {value} |
| 115 | [AaCOHyXu9tFduPng09zv](https://sonarcloud.io/project/issues?id=jtn0123_frigate&open=AaCOHyXu9tFduPng09zv) | `frigate/api/fastapi_app.py` startup/shutdown | Retain watchdog task and cancel/await it during shutdown |

Total: **100 additional distinct findings; 115 cumulative source fixes.**
