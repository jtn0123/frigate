# Upstream feature integration

This work targets the fork's `next` branch. The starting point was
`bb55f28f8`; upstream was reviewed through `6791df797`.

## Integrated batches

| Ledger ID | Behavior | Upstream source |
| --- | --- | --- |
| D62 | Correct event-rate statistics immediately after startup | Event-rate reliability fix |
| B15 | Audio label grouping with runtime label maps and score deduplication | `fd76eb6c6` |
| UI139 | Safari-compatible playback-rate controls | Safari playback changes |
| UI140 | Explicit live streaming technology selection and WebRTC probe handling | `64d6366ac` |
| B16 | Multiple Birdseye inclusion modes and review activity | `d6a18e79a`, `f4cf1e153` |
| B17 | Main/sub recordings, independent retention, adaptive playback and stream-aware exports | `1498231eb`, `e77155a4f`, `6ba9dd92e`, `3f2020933`, `53fb6c8da`, `82be9fff5` |
| B18 | Multiple detection models, camera scenes, hardware discovery and model editor | `8fe35ace3`, `27a40a507`, `46796fe9e`, `aaf18b81b`, `6ae805097`, `d183f03fe`, `7821ecbb4`, `6791df797`, `b99c87f27` |
| B19 | Persistent notices, acknowledgement and mute, hardware and stream health checks | `f3a31e2fb`, `70ce193e0`, `e3029beba`, `7bc32fd4c`, `9664d9cea`; recommendation helpers from `fb8ab56c4` |
| B20 | DEEPX NPU and lighter Apple Neural Engine, video presets and discovery | `af0ba1919`, `c959df32c`; ONNX Runtime prerequisite from `944328911` |

## Fork compatibility

Recording changes retain bounded clip queries, atomic file publication, ffmpeg
recovery grace periods, asynchronous subprocess cleanup, camera authorization,
and the fork's storage and diagnostic views. Blocking database work in media
routes runs in FastAPI's worker pool.

Model changes preserve the fork's GenAI frame captions, model resource telemetry,
settings change previews, Save All retries, and phone navigation. Model lists
replace atomically, so renamed or removed models do not linger in YAML. Runtime
model fields are stripped before saving. Repeated devices get separate runner
names and measurements.

Optional detector runtimes use pinned artifact checksums. The service exposes
Python's user-base `lib` and `bin` directories, including a `PYTHONUSERBASE`
override. This fork retains its existing bundled dependencies and service
identity; it does not adopt upstream's separate privilege-management changes.
The runtime installers apply only to configured detector types.

Notices are admin-only over both REST and WebSocket. The System health tab and
admin inbox link retain the existing camera-history Health tab, review inbox
read state, AI telemetry warnings, and compact status controls. Camera deletion
resolves its notices; authentication notices retain the fork's sanitized logging.

Hardware support retains the fork service identity and excludes upstream-only
CODEOWNERS and device-ACL bootstrap changes. DEEPX host installation remains an
explicit operator step. ONNX Runtime 1.30 is hash-pinned for both architectures,
and the thin test image installs that same wheel to exercise its provider API.

## Validation boundaries

Backend checks run in the fork's thin test image using Python 3.11. Frontend
unit tests and Playwright exercise the fork's actual components with mocked
camera/API data. They do not establish physical accelerator compatibility,
real-camera recording reliability, or Safari browser-engine behavior.

The recording checkpoint passed the backend gate (2,212 Frigate tests plus
116 companion/benchmark/monitoring tests), 19 focused player tests, and 93
browser tests with 14 platform skips. The model checkpoint's combined browser
run passed 134 tests with 14 platform skips; the backend gate passed
2,350 Frigate tests (one skipped) and 116 companion tests, including mypy and
the generated API check. The focused settings suite passed 55 tests. The notices backend gate passed
2,519 Frigate tests (one skipped) and 116 companion tests. Its admin-only
checks are loaded separately, keeping the eager bundle at 385,873 gzip bytes
under the unchanged 405,000-byte budget.

## Branch review

PRs #94 and #99 were already merged. PR #103's unmerged vehicle-label experiment
is excluded. The separate classification-suggestions work in PR #105 is not
duplicated here. PR #106 concerns image-size documentation. The unmerged
`section/features4` branch contains useful responsive-layout work to recover
selectively, rather than merging its entire older branch history.
