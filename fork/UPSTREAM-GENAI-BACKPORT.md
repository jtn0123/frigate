# Selected upstream backports for issue #91

Base: fork `next` at `274a29f87463bf62bfe97ddc4717e62b6514794d`.
Compared upstream: `af0ba191966812cf9ac8515d95b1dd221363d17e`.
Integrated current fork `next` at `e667a41a3` before PR validation.

## Included

| Area | Behavior | Upstream source |
| --- | --- | --- |
| Preview identity | `front` cannot load `front-door` cached frames | `410038373`, #24352 |
| Tracking and motion | Deregistering one object preserves healthy tracks; skipped full-frame motion updates the background | `52f50a739`, #24418 |
| Config validation | Invalid config exits 1 instead of validating safe-mode fallback | `0ca5cbbb6`, #24398 |
| Camera/audio lifecycle | Guard removed cameras and use snapshots; defer audio startup until metrics exist | `d78f6a7a9`, #23994; `52f50a739`, #24418 |
| Recording player | Clear settled paused loading and cancel stale timers | adapted from `9eef369dd`, #24162 |
| Exports | Rename the downloaded file with the display name, bounded UTF-8 filenames, rollback after DB failure | `0aa086eef`, #24111 |
| Training attempts | Remove the entire excess over the cap, tolerate concurrent deletion | `37f338d5d`, #24246 |
| Chat | Prompt refinements, configured object-name discovery, approval/rejection of write tools, export cases, export creation and event images | `b2345cdd0`, `15c41c985`, `af60d2db4` |
| Review GenAI | Response styles, manual generation and annotated frames | `76708e7fa`, `f9347967e`, `eccd10cd9` |
| Transcription | Choose local Whisper or a named GenAI provider; provider capabilities, audio buffering and explicit automatic language detection | `334073967`, #24396 |
| Provider settings | Clear stale models on provider change, retain selected roles during capability refresh, deduplicate llama.cpp aliases | selected `3d08bbe52`, #24402 |

## Compatibility decisions

- Existing transcription remains local Whisper with language `en`. Set language
  to `auto` explicitly to detect it. A named GenAI provider must have the
  `transcribe` role; this role is never granted implicitly.
- Local Whisper retains the ctranslate2-before-ONNX preload needed by the fork's
  ROCm runtime. Provider-backed transcription does not preload ctranslate2.
- Ollama descriptions use the chat API to keep image captions next to images.
  The fork's active-request accounting and optional timing telemetry remain.
- Review annotations use the existing global detector model configuration. The
  separate upstream detector/model migration is not a prerequisite here.
- Manual review generation requires an admin, an ended review, an existing camera
  with review GenAI enabled, and a descriptions provider. The UI also checks the
  provider's reported context size. Acceptance queues work; it does not mean a
  description has already been generated.
- Chat write approvals do not replace role or camera checks. Existing camera-watch
  ownership checks remain. Chat case lists reuse the Export page visibility
  filter so inaccessible case names and descriptions remain private.
  Object-name discovery filters custom categories by
  objects tracked on accessible cameras, including the no-access case.
- File and database work added to async routes runs in worker threads. Case ZIPs
  retain the fork's display-name behavior for older exports, including Unicode
  names whose existing on-disk filename differs.
- Generated API schema, TypeScript API types, configuration translations and mock
  configuration/schema fixtures are regenerated from the adapted source.

## Already covered or kept separate

D33 already handled preview startup matching; only the missing lookup helper is
changed. D21 backports, D42 recording exception handling, E7 config safeguards,
G13/G14 query/delete work, existing zone rename protections, and the dependency
refresh are retained. No wholesale lockfile or upstream branch replacement occurs.

The recording/substream schema, detector architecture, non-root container migration,
notices/System Health, face-recognition rewrite and major frontend tooling updates
remain coordinated migration work. The camera-history and footage-search changes
merged into `next` are retained. These backports do not complete issue #91's full
branch integration.

## Validation

Regression tests reproduce the old preview/tracker/motion/config failures and
verify the corrected behavior. The player test reproduces the returning spinner
after canceled scrubbing and covers unloaded media, camera switching and stale
timers. Backend tests cover camera/audio lifecycle, export rollback and naming,
image caps, GenAI providers, annotations, buffering, approval decisions, access
controls and defaults. Browser coverage exercises provider settings and chat
approval/resume, with hook tests for manual-generation availability and feedback.

All provider and camera interactions in these checks use mocks or fixtures. Live
provider output quality, ROCm hardware behavior and deployment remain separate
validation; no production configuration or release promotion is changed.

### Local results (2026-09-21)

- Full backend suite: 1,629 tests completed, one existing skip, no failures.
- Fork audio/benchmark/monitoring suites: 76 + 15 + 25 tests passed.
- Backend mypy: 443 source files passed; generated API spec drift check passed.
- Frontend unit suite: 647 tests across 97 files passed.
- Lint, TypeScript, type ratchet, i18n, Ruff, fork mypy, secret scan, production
  build and bundle budget passed.
- The host script gate initially lacked `defusedxml` in the isolated Python 3.11
  environment. After installing it there, the unchanged script suite passed all
  161 tests. This was a test-environment correction, with no repository dependency
  change.
- Targeted desktop/mobile browser run: 19 tests passed.
- Full desktop/mobile browser suite: 695 passed, 95 skipped, no failures.
- The full check runner reported its earlier script-environment failure; that
  gate was rerun successfully as recorded above. Other full-run gates passed.
- Final prompt punctuation cleanup: six prompt tests passed.

The implementation is prepared on `section/upstream-genai-reliability` for a
fork PR targeting `next`. Deployment and release promotion remain separate.
