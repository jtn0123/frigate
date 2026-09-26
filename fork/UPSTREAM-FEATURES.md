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
| UI141 | Responsive shell, screen-size layouts, touch resize and capability-based picture-in-picture | recovered from `56e02f38e` on `section/features4` |
| D63 | Plate-picker focus and rapid-reopening regression fix | Found during integration browser testing |

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

Responsive layouts retain the fork router, preloading, phone insets and touch
controls. Layout backups carry each screen-size variant and remap it to the
receiving browser. Legacy backups still import. Reset and group deletion clear
the relevant variants. A regression test reproduces a late storage read
overwriting the newly selected viewport before the persistence fix.

## Validation

The final combined `make check` passed on 2026-09-25 against `origin/next`
`bb55f28f8`, with the integration on `section/upstream-feature-integration`.

| Check | Result |
| --- | --- |
| Frigate backend unit tests | 2,565 tests, one existing skip |
| Audio, benchmark and monitoring tests | 116 passed |
| Fork tooling unit tests | 196 passed |
| Frontend unit tests | 852 passed across 134 files |
| Playwright, desktop/mobile/tablet | 909 passed, 101 platform skips, zero failures or flaky tests |
| Eager bundle | 386,284 gzip bytes, below the unchanged 405,000-byte budget |
| Other gates | ESLint, app/e2e/fork TypeScript, type ratchet, i18n, Ruff, Python mypy, generated API spec and gitleaks passed |

Hardware support also passed 147 focused backend tests. Responsive persistence,
backup and reset passed 27 focused unit tests. The layout race was reproduced
before its fix; the plate-picker regression passed on desktop and mobile.

Backend checks use Python 3.11 in the fork's thin ARM64 test image, including
the pinned ONNX Runtime 1.30 wheel. Frontend and Playwright tests exercise the
actual components with mocked camera/API data. They do not establish physical
accelerator compatibility, real-camera recording reliability, native Safari
behavior, or a full production-image build. Remote CI and SonarCloud have not
run for this local branch. Nothing has been pushed, merged, promoted or deployed.

## Branch review

Refreshed against `origin/next` at `bb55f28f8`. PRs #94 and #99 are merged.

| Branch or PR | Disposition |
| --- | --- |
| `section/vehicle-label-trial`, PR #103 | Closed and unmerged; excluded as requested |
| `section/classification-suggestions`, PR #105 | Open against `next`; existing separate work, not duplicated here |
| `dependabot/npm_and_yarn/docs/image-size-2.0.4`, PR #106 | Open docs dependency update |
| `section/features4` | Responsive work recovered as UI141 without merging the older branch history |
| `claude/open-pull-requests-ak6psd` | Only merge commits remain outside `next` |
| `pr99` | Non-merge patches already have equivalents on `next` |
| `pr-assets` | Screenshot publication branch, not application features |
| `dev` | Upstream tracking branch, not a fork feature branch |
