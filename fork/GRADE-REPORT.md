# Codebase Grade Report

**Project:** frigate — fork `jtn0123/frigate`, branch `main` (named `polish` until 2026-09-10) @ 752bc3047 (base upstream v0.18.0-rc2)
**Audited:** 2026-09-10 (regrade; baseline audit of upstream `dev` the same morning)
**Stack:** Python 3.11 / FastAPI 0.116 / peewee 3.17 + SQLite (WAL) / pydantic 2.10 / ZMQ multiprocess pipeline, go2rtc + ffmpeg binaries; React 19 / TypeScript 5.9 (strict) / Vite 6 / Tailwind 3 / Radix + shadcn / SWR / react-router 6 / i18next 24; vitest + Playwright; Debian 12 Docker image, nginx front
**Focus:** frontend (`web/`) — this fork exists for UI/UX work

**How IDs work in this file.** IDs are stable across regrades because commits,
`FORK.md` and `fork/PLAN.md` refer to them. Done items are struck through
with ✓ and kept as one line. New items take the next free number in their
category. Product features live in the **UX feature track** (UI1…) at the
end. `fork/PLAN.md` and then `fork/PLAN2.md` decide the order work happens in;
this file says what each item is.

## Summary

| ID | Category | Baseline | Now | Open items |
|----|----------|----------|-----|------------|
| A | Architecture & Design | B− | B− | 5 |
| B | Backend Quality | B− | B | 2 |
| C | Frontend Quality | C | C+ | 7 |
| D | Testing & Reliability | C+ | B− | 7 |
| E | Security | B+ | B+ | 3 |
| F | Dependencies & Tech Currency | C+ | B− | 2 |
| G | Performance & Scalability | C+ | B− | 6 |
| H | Documentation & Onboarding | C | C+ | 3 |
| I | Developer Experience & Tooling | C+ | B | 6 |
| **Overall** | | **B−** | **B** | **41** + UX track |

**Top 5 highest-leverage open fixes:** E5, E4, I6, D2, G9

**Type safety at a glance.** Frontend: TypeScript `strict` (plus
`noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`) gates the build;
escape hatches are few (23 explicit `any`, 18 `@ts-expect-error`, 20
`as unknown as`, no `@ts-ignore`). The weak seam is the API boundary: 2,187
lines of hand-written types in `web/src/types/` and no runtime validation of
responses, so TypeScript trusts whatever the server sends. Backend: config is
strongly validated by 166 pydantic models, but mypy's strict flags are
switched off (`ignore_errors`) for `api`, `config`, `util`, `video`,
`detectors`, `embeddings`, `ptz`, `http`, `debug_replay` and tests; 70% of
functions are fully annotated, with 147 `type: ignore` and 784 `Any`; only
77 of 179 routes declare a `response_model`; the peewee ORM is untyped.

---

## A — Architecture & Design — B−

Unchanged grade. The process model (ZMQ IPC `frigate/comms/zmq_proxy.py`,
shared-memory frames `frigate/app.py`) is still the strongest part. The fork
added its code in isolated folders (`web/src/{components,hooks,lib,views}/fork/`,
`web/src/fork/flags.ts`) behind runtime flags, which keeps rebases cheap. Still
held back by god modules (`web/src/pages/Settings.tsx` 2,373 lines, 36
frontend files over 800 lines, `frigate/api/event.py`), no service layer, UA
sniffing for layout (205 `isMobile` / 389 `isDesktop` references), and an
untyped client/server contract.

#### A1 — Introduce a viewport hook and retire user-agent layout branching `[fork]` (= UI5)
- **Where:** `web/src/App.tsx`, `components/navigation/{Sidebar,Bottombar,NavItem}.tsx`, `hooks/use-navigation.ts`; 594 `isMobile`/`isDesktop` references; partial work on `section/features4` (`wip:` commit)
- **What's wrong:** Layout is picked from UA constants evaluated once; narrow desktop windows and rotated tablets get the wrong tree.
- **Fix:** `web/src/hooks/fork/use-viewport.ts` (`matchMedia` + `useSyncExternalStore`) for the shell and navigation only, flag `viewportLayout`; ships with D3. Not a full migration.
- **Effort:** M (scoped)
- **Grade lift:** B− → B− (removes the worst layout bug; the full migration stays out of scope)

#### A5 — Generate frontend API types from the OpenAPI spec `[fork, upstreamable]`
- **Where:** `web/src/types/` (29 files, 2,187 lines, hand-written), `docs/static/frigate-api.yaml` (generated and CI-checked by `generate_api_auth_spec.py --check`)
- **What's wrong:** The one untyped seam in an otherwise typed app. When an upstream rebase changes a response, the UI compiles fine and breaks at runtime.
- **Fix:** Generate `web/src/types/fork/api.gen.ts` from the spec (`openapi-typescript`, dev dependency only) in a CI-checked script; migrate the most-used SWR keys (`config`, `review`, `events`, `stats`) to generated types first. Coverage grows as B2 adds response models.
- **Effort:** M
- **Grade lift:** B− → B (turns API drift into compile errors)

#### A2 — Split `ws.ts` into transport, state diffing and hooks `[fork]` — backlog
- **Where:** `web/src/api/ws.ts` (886 lines)
- **What's wrong:** Protocol parsing, camera-activity diffing and ~50 hooks share one file. It already uses per-topic `useSyncExternalStore`, so this is structure, not performance.
- **Fix:** `web/src/api/ws/{store,protocol,hooks}.ts`, `ws.ts` re-exports.
- **Effort:** S
- **Grade lift:** B− → B− (testability, conflict surface)

#### A3 — Add a service layer for the largest routers `[upstream]` — backlog
- **Where:** `frigate/api/event.py`, `media.py`, `camera.py`, `app.py` (config redaction)
- **What's wrong:** Handlers hold business logic and query peewee directly.
- **Fix:** `frigate/services/<domain>.py`, one router at a time.
- **Effort:** L
- **Grade lift:** B− → B

#### A4 — Retire the duplicated `useSWR("config")` and dead wrappers in the app shell `[fork]` — backlog
- **Where:** `web/src/App.tsx`, `web/src/api/index.tsx` (`WsWithConfig`)
- **What's wrong:** Noise in the file every fork change touches.
- **Fix:** Fetch config once; delete `WsWithConfig`; drop stray text nodes.
- **Effort:** S
- **Grade lift:** B− → B− (hygiene)

---

## B — Backend Quality — B

Up from B−. One error shape now reaches every client (B1), silent exception
swallows log (B3), handlers no longer block the event loop (G3), and every
route declares exactly one auth gate checked at startup (E2). Remaining: 102 of
179 routes return raw dicts with no `response_model`, peewee models omit the
indexes that migrations create, and business logic still lives in routers
(A3).

- ~~B1~~ ✓ done 2026-09-10 — HTTPException renders `{success, message, detail}`
- ~~B3~~ ✓ done 2026-09-10 — 25 `except Exception: pass` sites log; bare `except:` narrowed

#### B2 — Declare `response_model` on the remaining 102 routes `[upstream]` — backlog
- **Where:** `frigate/api/*.py` (77 of 179 routes covered); models in `frigate/api/defs/response/`
- **What's wrong:** Half the API is untyped in the OpenAPI spec, which also limits A5.
- **Fix:** Add pydantic response models, frontend-heaviest routes first (`review`, `events`, `config`, `stats`).
- **Effort:** L
- **Grade lift:** B → B+

#### B4 — Declare indexes on models, not only in migrations `[upstream]` — backlog
- **Where:** `migrations/011`, `020`, `022`, `027` vs `frigate/models.py`
- **What's wrong:** Models under-document the real schema.
- **Fix:** Matching `class Meta: indexes`; migrations stay authoritative.
- **Effort:** S
- **Grade lift:** B → B (hygiene)

---

## C — Frontend Quality — C+

Up from C. No more blank screens (route error boundary, C1), read failures
surface (C5), 42 clickable non-buttons became real controls with a keyboard
spec (C2), the sandbox left production (C8), and appearance controls landed
(UI15). Still C+: the god components and prop drilling are untouched (by
design, to stay rebasable), 109 `exhaustive-deps` suppressions remain, 83
jsx-a11y warnings remain at `warn`, and the Settings save transaction is
untested.

- ~~C1~~ ✓ done 2026-09-10 — `components/fork/RouteErrorBoundary.tsx`, chunk-load recovery
- ~~C2~~ ✓ done 2026-09-10 — jsx-a11y lint, 42 role/tabIndex sites, 27 real buttons, 16 alt texts, keyboard listener fix (residue tracked as C9)
- ~~C5~~ ✓ done 2026-09-10 — SWR read-error toasts + `ErrorState`
- ~~C8~~ ✓ done 2026-09-10 — sandbox gated to dev, hygiene nits

#### C9 — Ratchet the remaining 83 jsx-a11y warnings to errors `[fork, upstreamable]`
- **Where:** `web/eslint.config.js:25-30` (all jsx-a11y rules downgraded to `warn`); by rule: label-has-for 24, no-noninteractive-tabindex 13, no-static-element-interactions 11, control-has-associated-label 9, no-autofocus 8, click-events-have-key-events 5, role-has-required-aria-props 4, media-has-caption 3, aria-role 3, no-noninteractive-element-to-interactive-role 2, heading-has-content 1 (e.g. `views/explore/ExploreView.tsx:191,288`, `views/live/DraggableGridLayout.tsx:842,923`, `views/settings/Go2RtcStreamsSettingsView.tsx:600,680`)
- **What's wrong:** Warnings do not block regressions; new inaccessible markup lands silently.
- **Fix:** One rule per commit: fix every site, then set that rule to `error`. No `eslint-disable`; a site that needs a rewrite keeps its rule at `warn` and is listed in `fork/PLAN.md` Follow-ups.
- **Effort:** M
- **Grade lift:** C+ → B− (accessibility becomes enforced, not advisory)

#### C3 — Extract the Settings "Save All" transaction into a tested module `[fork]`
- **Where:** `web/src/pages/Settings.tsx` save path (per-section payloads, detector/model PUT, go2rtc diff + delete, restart flags, `Promise.allSettled`, `mutate("config")`)
- **What's wrong:** The riskiest UI logic is inline and untested; UI7's diff dialog builds on it.
- **Fix:** Local split only: `web/src/lib/fork/settings-save.ts` with vitest for ordering, partial failure and restart-required; small hunk in `Settings.tsx`.
- **Effort:** M
- **Grade lift:** C+ → C+ (risk reduction; enables D2 assertions)

#### C10 — Ratchet TypeScript escape hatches `[fork]`
- **Where:** `web/src`: 23 explicit `any` (+25 `no-explicit-any` disables), 18 `@ts-expect-error`, 20 `as unknown as`; `web/eslint.config.js:46` uses `tseslint.configs.recommended`, not the type-checked presets
- **What's wrong:** Each hatch is a spot where strict mode is switched off by hand; nothing stops the count growing.
- **Fix:** Replace hatches in fork-touched files first; add a CI count check that fails if any of the three counts rises; trial `recommendedTypeChecked` on `web/src/**/fork/**` only.
- **Effort:** S
- **Grade lift:** C+ → C+ (type-safety hygiene; pairs with A5)

#### C11 — Fix floating and misused promises `[fork, upstreamable]`
- **Where:** `web/src`: 136 `@typescript-eslint/no-floating-promises` in 62 files, 127 `no-misused-promises` in 72 files (hotspots `views/settings/AuthenticationView.tsx` 10, `components/card/ReviewCard.tsx` 9, `components/settings/wizard/Step2ProbeOrSnapshot.tsx` 9, `pages/Events.tsx` 9); measured 2026-09-10 with the type-aware rules, which the lint config does not enable
- **What's wrong:** Rejected promises vanish and async handlers passed to `onClick` and similar have unhandled failures; users see "the button did nothing".
- **Fix:** Await with error handling (existing toasts), `void` only for intended fire-and-forget with a comment, wrap async handlers; then set both rules to `error` for all of `web/src` (see `fork/PLAN2.md` PR-04).
- **Effort:** M
- **Grade lift:** C+ → B− (with C9)

#### C4 — Kill four-level prop drilling in Events → EventView → DetectionReview → MotionReview `[fork]` — backlog
- **Where:** `web/src/pages/Events.tsx` → `views/events/EventView.tsx` (1,767 lines); `SearchDetailDialog.tsx` (1,910)
- **What's wrong:** Props pass through four levels with renames.
- **Fix:** `ReviewPageContext`; only as a local split when a feature touches these files.
- **Effort:** M
- **Grade lift:** C+ → B−

#### C6 — Break up the three worst god components `[fork]` — backlog
- **Where:** `views/live/LiveCameraView.tsx` (1,827), `views/motion-search/MotionSearchView.tsx` (1,644), `components/overlay/detail/SearchDetailDialog.tsx` (1,910)
- **What's wrong:** Fetching, rules and layout fused; guaranteed rebase conflicts.
- **Fix:** Controller hook + sub-component folder, one file at a time, only when a feature needs it.
- **Effort:** L
- **Grade lift:** C+ → B−

#### C7 — Reduce the 109 `exhaustive-deps` suppressions `[fork]` — backlog
- **Where:** `web/src` (163 `eslint-disable`, 109 for `react-hooks/exhaustive-deps`)
- **What's wrong:** Deliberately stale closures whose correctness depends on comments.
- **Fix:** Stable callbacks or derived state; CI count ratchet like C10.
- **Effort:** M
- **Grade lift:** C+ → B−

---

## D — Testing & Reliability — B−

Up from C+. Frontend unit testing works again (6 files, 147 tests, v8
coverage in CI) and found real bugs (dateUtil locales, transformer `allOf`,
go2rtc route errors). E2E grew to 27 specs (331 passing, 95 skipped by
viewport) with an error collector and a keyboard spec; backend has 78 test
files / 958 tests, all green in CI. Held at B−: unit line coverage is 5.2%
(pure modules only), the riskiest screens have no e2e (D2), the tracking
pipeline has no unit tests (D4), and nothing catches visual regressions.

- ~~D1~~ ✓ done 2026-09-10 — `web/__test__/test-setup.ts`, 147 tests, CI step
- ~~D5~~ ✓ web half done 2026-09-10 — vitest v8 coverage uploaded by "Fork - Checks" (Python half → D8)

#### D8 — Report Python coverage in CI `[BE] [fork, upstreamable]`
- **Where:** `.github/workflows/fork-checks.yml` "Python - Tests" (plain `unittest` in the thin image), `Makefile` `test-py`
- **What's wrong:** Backend coverage is unknown, so D4 and future backend changes have no baseline or ratchet.
- **Fix:** `coverage run -m unittest` inside `frigate-fork-test` (add `coverage` to `docker/main/requirements-dev.txt` if missing), print the summary and upload the XML; no gate at first.
- **Effort:** S
- **Grade lift:** B− → B− (enables a backend ratchet)

#### D2 — Cover Settings, MotionSearch, zone editing and the camera wizard in e2e `[FE] [fork]`
- **Where:** `web/e2e/specs/settings/ui-settings.spec.ts` (3 smoke tests); no spec for `views/motion-search/MotionSearchView.tsx`, `MasksAndZonesView` / `ZoneEditPane` / `PolygonCanvas`, `settings/wizard/`
- **What's wrong:** The pages a UX fork changes most are the least tested.
- **Fix:** One spec each (desktop + `@mobile`), asserting request payloads, following `e2e/fixtures/frigate-test.ts`.
- **Effort:** M
- **Grade lift:** B− → B

#### D6 — Visual regression screenshots `[FE] [fork]`
- **Where:** `web/e2e/playwright.config.ts` (no `toHaveScreenshot` anywhere); fork UI in `web/src/components/fork/`, `themes/fork-appearance.css`
- **What's wrong:** A rebase or dependency bump can silently undo polish (spacing, OLED theme, density) and every functional test still passes.
- **Fix:** A `visual` project, ~8 views × desktop/mobile on mocked data, dynamic regions masked, `maxDiffPixelRatio` ≈ 0.01; Linux baselines produced by a `workflow_dispatch` input on "Fork - Checks" that uploads them as an artifact.
- **Effort:** M
- **Grade lift:** B− → B− (protects C/UX gains)

#### D3 — Add a tablet viewport to the e2e matrix `[FE] [fork]`
- **Where:** `web/e2e/playwright.config.ts` (desktop 1920×1080 and phone 390×844 only)
- **What's wrong:** The 700–1,100 px range, where UA layout breaks, is untested.
- **Fix:** 1024×768 project; ships with A1.
- **Effort:** S
- **Grade lift:** B− → B− (prerequisite for A1)

#### D4 — Test the core tracking pipeline `[BE] [upstream]` — backlog
- **Where:** `frigate/track/object_processing.py`, `frigate/comms/dispatcher.py`
- **What's wrong:** The detection-to-event path has no unit tests.
- **Fix:** Fixture-driven synthetic detections through `TrackedObjectProcessor`.
- **Effort:** M
- **Grade lift:** B− → B

#### D7 — Refresh e2e mocks from real responses `[FE] [fork]` — backlog (needs I7)
- **Where:** `web/e2e/fixtures/` (hand-built mock payloads)
- **What's wrong:** Mocks drift from the real API across upstream rebases.
- **Fix:** Record responses from the I7 demo stack into fixtures with a script; diff on rebase.
- **Effort:** S
- **Grade lift:** B− → B− (fidelity)

#### D9 — Validate e2e mock fixtures against the API spec `[FE] [fork]`
- **Where:** `web/e2e/fixtures/` (hand-built JSON payloads), `docs/static/frigate-api.yaml`
- **What's wrong:** Mocks can drift from the real API after an upstream rebase and the e2e suite keeps passing against a shape the server no longer sends.
- **Fix:** Validate every fixture against the spec's response schemas in the e2e setup (ships with A5 in `fork/PLAN2.md` PR-01).
- **Effort:** S
- **Grade lift:** B− → B− (test fidelity)

#### D10 — Fall back to software decoding when hardware decoding keeps killing a camera `[BE] [FE] [fork, upstreamable]`
- **Where:** `frigate/video/ffmpeg.py` `CameraWatchdog` (restarts the detect ffmpeg with the same command after every crash), `frigate/ffmpeg_presets.py` (VAAPI detect scales on the GPU, then `hwdownload`)
- **What's wrong:** Found on the owner's server 2026-09-11: one Tapo C120 behind a UHD 730 crashed its detect stream every ~40 s with VAAPI `Failed to sync surface` / `hwdownload: Failed to download frame`, while the three identical cameras were fine. ffmpeg treats a filter error as fatal, so each occurrence kills detection for ~10 s and the watchdog restarts the identical command forever. The same stream decodes cleanly in software, with QSV, or with VAAPI decode plus software scaling, and no GPU hang is logged on the host.
- **Fix:** Count detect exits whose last ffmpeg lines name a hardware-decoding failure; after 3 in 10 minutes, restart that camera's detect stream with the software command (built from a copy of the config with hwaccel cleared), log one warning, publish `hwaccel_fallback` in the camera stats, and show it on Camera Health and in the status bar. Reset when the camera's ffmpeg config changes.
- **Effort:** S
- **Grade lift:** B− → B− (reliability)

#### D11 — Track camera restarts with a reason, and stop flooding the log `[BE] [FE] [fork, upstreamable]`
- **Where:** `frigate/video/ffmpeg.py` `CameraWatchdog` (every exit logs "last 100 lines" plus the dump at ERROR; "crashed unexpectedly" repeats every second until the 10 s retry), `frigate/stats/util.py` (only `reconnects_last_hour`, no reason)
- **What's wrong:** Investigating D10 meant reading raw logs: a camera in a bad spell wrote the same 100-line block every minute, and nothing recorded how often or why a feed restarted, so a pattern (which camera, which failure, when) needed a long external benchmark to see.
- **Fix:** Classify each exit from ffmpeg's last lines (hardware decoding, connection, stalled, other); keep 24 h per camera in a manager list; publish count, per-kind counts and the last 10 in camera stats; Camera Health shows one collapsed line only when a camera restarted. Log the full dump once per failure kind per hour and one counted line for repeats; log "crashed unexpectedly" once per crash.
- **Effort:** S
- **Grade lift:** B− → B− (operability)

---

## E — Security — B+

Structurally stronger than the baseline (E1 headers + HSTS fix, E2 per-route
auth markers with a startup assertion, E3 `safe_join`) and the repo now has
secret scanning + push protection, gitleaks in CI and hooks, CodeQL, Dependabot
alerts and grouped security PRs, and branch rulesets. The grade holds at B+
because the first scans found work that is not done yet: 3 critical and 11
high CodeQL alerts in upstream code are untriaged, shipped dependencies carry
known high-severity advisories, and CSP is still report-only.

- ~~E1~~ ✓ done 2026-09-10 — `security_headers.conf`, HSTS in every `add_header` location, CSP report-only
- ~~E2~~ ✓ done 2026-09-10 — one auth gate per route, startup assertion + test
- ~~E3~~ ✓ done 2026-09-10 — `safe_join` in `preview_thumbnail`

#### E5 — Patch vulnerable dependencies that ship in the image `[fork]`
- **Where:** `docker/main/requirements-wheels.txt` (`python-multipart`, 2 high), `web/package-lock.json` (axios 10 high, fast-uri 6, nanoid 3, postcss 2, form-data 1, others); Dependabot PRs #1–#6 on `jtn0123/frigate` (opened before grouping, on a base with a since-fixed CI error)
- **What's wrong:** Known advisories in code users run. 125 of the 221 alerts are in `docs/` and 16 in unbuilt TensorRT/ARM manifests (now ignored); the rest matter.
- **Fix:** Merge the grouped `security` PRs for `/web` and `/docker/main` once green (patch/minor only), close superseded single PRs, `SEC` ledger row; majors stay open and are listed in Follow-ups.
- **Effort:** S
- **Grade lift:** B+ → A− (with E4)

#### E4 — Triage the CodeQL findings in upstream code `[upstream]`
- **Where:** critical `py/command-line-injection` `frigate/util/image.py:1221`, `frigate/util/services.py:1017`; critical `py/full-ssrf` `frigate/api/camera.py:505`; high `py/clear-text-logging-sensitive-data` `frigate/api/auth.py:331-384`, `frigate/app.py:537,555`, `frigate/util/services.py:1021`; high `py/polynomial-redos` `frigate/util/builtin.py:113,123`; 14 medium `actions/missing-workflow-permissions` in disabled upstream workflows
- **What's wrong:** Unreviewed criticals make the Security tab useless as a signal, and some may be real (e.g. an SSRF reachable by a non-admin role).
- **Fix:** For each: trace the source to the sink, then fix as a small "candidate" commit with a test, or dismiss with a written reason. Dismiss the disabled-workflow alerts as "won't fix".
- **Effort:** M
- **Grade lift:** B+ → A− (with E5)

#### E6 — Move CSP from report-only to enforced `[upstream]` — backlog
- **Where:** `docker/main/rootfs/usr/local/nginx/conf/security_headers.conf:21` (`Content-Security-Policy-Report-Only`)
- **What's wrong:** The policy is written but protects nothing yet.
- **Fix:** Collect violations in the I7 demo stack across all pages (monaco workers, blob players, go2rtc WebRTC page), tighten, then enforce.
- **Effort:** M
- **Grade lift:** A− → A (once E4/E5 are done)

---

## F — Dependencies & Tech Currency — B−

Up from C+. ESLint 9 flat config + typescript-eslint 8 (F1), checksummed
binary downloads and pinned actions (F2), and a clean wheel set without
runtime mypy or duplicate OpenCV (F3). Several frontend majors are still
behind (Tailwind 3, react-router 6, i18next 24, apexcharts 3, date-fns 3,
vite 6), numpy is pinned to 1.26, and a few abandoned packages remain.
Deliberately, the fork takes no major upstream has not taken.

- ~~F1~~ ✓ done 2026-09-10 — `web/eslint.config.js`
- ~~F2~~ ✓ done 2026-09-10 — go2rtc/ffmpeg SHA256, py3nvml commit pin, `actions/stale@v9.1.0`
- ~~F6~~ ✓ done 2026-09-11 — web minor/patch refresh within majors, then the held packages (konva, monaco-yaml, react-logviewer, Playwright, Prettier) with small fixes; only react-apexcharts waits for the apexcharts major
- ~~F3~~ ✓ done 2026-09-10 — mypy out of runtime, single `opencv-contrib-python-headless`

#### F5 — Retire abandoned packages and document the Radix patches `[fork, upstreamable]`
- **Where:** `web/package.json` (~~`sort-by`~~ removed 2026-09-11, `strftime`, `nosleep.js`, `vite-plugin-monaco-editor` interop hack), `web/patches/*.patch` (no README), repo-root stub `package-lock.json`
- **What's wrong:** Dormant dependencies and two unexplained patches that will bite on upgrade.
- **Fix:** Replace the three small deps; `web/patches/README.md` (lands with H3); delete the stub lockfile.
- **Effort:** S
- **Grade lift:** B− → B−

#### F4 — Frontend major bumps `[fork]` — backlog, scheduled last (owner OK 2026-09-11)
- **Where:** `web/package.json`: 34 packages a major behind on 2026-09-11 (toolchain: TypeScript 5.9, Vite 6, Vitest 3, ESLint 9, Tailwind 3, jsdom 24; runtime: react-router 6, i18next 24 / react-i18next 15, date-fns 3, zod 3, apexcharts 3, lucide 0.x, framer-motion 12, react-dropzone 14, tailwind-merge 2)
- **What's wrong:** One or more majors behind each; react-router 6 and vitest 3 carry open Dependabot alerts (react-router: Dependabot #7) that only the next major fixes.
- **Fix:** Last phase, after the debugging and type-safety blocks: one PR per major (or tightly coupled group, e.g. react-router + react-router-dom, i18next + react-i18next). Toolchain first (I11), then runtime libraries by alert and risk, Tailwind 4 last (widest diff). Each PR records before/after gates and accepts the extra `package-lock.json` conflict on upstream syncs. Python pins stay upstream-owned (security fixes only).
- **Effort:** L
- **Grade lift:** B− → B

---

## G — Performance & Scalability — B−

Up from C+. Eager JS fell from 504 to 305 kB gzip (G1, G5 chunks and lazy
players), SWR has a sane global policy (G2), async handlers stopped blocking
(G3), event search is bounded in SQL (G4), and the recording maintainer
stopped walking every host process (G6). Remaining costs are measurable: no
list is virtualised anywhere, the Settings form chunk is 246 kB gzip, only 9
of 33 `<img>` load lazily, hashed assets are not `immutable`, and summary
endpoints have no HTTP caching.

- ~~G1~~ ✓ done 2026-09-10 — explicit icon map, lazy settings menus
- ~~G2~~ ✓ done 2026-09-10 — `dedupingInterval` 2000, `focusThrottleInterval` 10000, `errorRetryCount` 3
- ~~G3~~ ✓ done 2026-09-10 — sync handlers are `def`, awaited ones use `asyncio.to_thread`; ruff `ASYNC`
- ~~G4~~ ✓ done 2026-09-10 — SQL ORDER BY/LIMIT, bounded vector candidates, windowed review join
- ~~G5~~ ✓ done 2026-09-10 (except virtualisation → G9) — lazy players, `manualChunks`, memoised cards
- ~~G6~~ ✓ done 2026-09-10 — `frigate/record/cache_tracker.py`

#### G9 — Virtualise the card grids and lazy-load images `[fork, upstreamable]`
- **Where:** `web/src/views/search/SearchView.tsx`, `views/events/EventView.tsx`, `views/recording/RecordingView.tsx` (infinite scroll keeps every card mounted; no virtualisation library in `package.json`); 24 of 33 `<img>` in `web/src` lack `loading="lazy"` / `decoding="async"`
- **What's wrong:** Long Review/Explore sessions grow the DOM and image memory without bound; offscreen thumbnails compete with visible ones.
- **Fix:** `@tanstack/react-virtual` (small, no peer majors) for the three grids behind a flag; add `loading="lazy" decoding="async"` to non-critical images.
- **Effort:** M
- **Grade lift:** B− → B (largest runtime win)

#### G8 — Put the Settings form chunk on a diet `[fork, upstreamable]`
- **Where:** `web/dist/assets/ConfigSectionTemplate-*.js` 246 kB gzip (`@rjsf/core`, `@rjsf/shadcn`, `@rjsf/validator-ajv8` compiling schemas at runtime); `web/package.json:51-54`
- **What's wrong:** Every Settings visit downloads and compiles a schema validator before the form is usable.
- **Fix:** Precompile validators at build time (ajv standalone via a Vite plugin or prebuild script) or load `validator-ajv8` on first validation; measure before/after with G7.
- **Effort:** M
- **Grade lift:** B− → B− (Settings load time)

#### G7 — Bundle budget in CI `[fork]`
- **Where:** `.github/workflows/fork-checks.yml` (build job has no size check); `web/vite.config.ts` (`chunkSizeWarningLimit: 900` is advisory)
- **What's wrong:** The 504 → 305 kB win can erode one import at a time.
- **Fix:** `web/scripts/fork/bundle-budget.mjs` gzips everything `dist/index.html` loads eagerly and fails above `fork/bundle-budget.json` (measured + 5%).
- **Effort:** S
- **Grade lift:** B− → B− (locks in G1/G5)

#### G10 — Immutable, precompressed static assets `[upstream]`
- **Where:** `docker/main/rootfs/usr/local/nginx/conf/nginx.conf:328-333` (`/assets/` has `expires 1y` + `Cache-Control "public"`, no `immutable`); `:33-37` (gzip on the fly at level 6; no `gzip_static`)
- **What's wrong:** Reloads revalidate every hashed chunk; nginx recompresses the same files per request.
- **Fix:** `Cache-Control: public, max-age=31536000, immutable` for `/assets/`; emit `.gz` at build and enable `gzip_static` there.
- **Effort:** S
- **Grade lift:** B− → B− (repeat-visit latency, server CPU)

#### G11 — HTTP caching for summary endpoints `[upstream]`
- **Where:** `frigate/api/review.py:207` (`review_summary`), `frigate/api/record.py:62,123` (`all_recordings_summary`, `recordings_summary`); zero `ETag`/`Last-Modified` handling in `frigate/api/`
- **What's wrong:** Summaries are recomputed and re-sent on every poll and focus even when nothing changed.
- **Fix:** Profile first in the I7 demo stack; then an ETag from the newest relevant row timestamp with a 304 path.
- **Effort:** M
- **Grade lift:** B− → B− (API load under many clients)

#### G12 — Web-vitals budget on key pages `[fork]` — backlog (needs I7)
- **Where:** no LCP/INP/CLS measurement anywhere
- **What's wrong:** Bundle size is a proxy; real interaction latency is unmeasured.
- **Fix:** Lighthouse CI (or `web-vitals` in a Playwright run) against the demo stack; fail on regression.
- **Effort:** M
- **Grade lift:** B → B

---

## H — Documentation & Onboarding — C+

Up from C. Wrong statements fixed (H1), CONTRIBUTING lists every CI gate (H2),
and the fork has a ledger (`FORK.md`), a plan (`fork/PLAN.md`) and this
report. The frontend still has a 25-line README for 129k lines of TypeScript,
there is no e2e README, and no architecture page.

- ~~H1~~ ✓ done 2026-09-10
- ~~H2~~ ✓ done 2026-09-10

#### H3 — Frontend, e2e and patches READMEs `[fork]`
- **Where:** `web/README.md` (25 lines), no `web/e2e/README.md`, no `web/patches/README.md`
- **What's wrong:** Directory rules, the base-path sentinel, e2e mocking, i18n workflow and the patches are undocumented.
- **Fix:** Write the three READMEs (lands with features4).
- **Effort:** S
- **Grade lift:** C+ → B−

#### H4 — Architecture page `[upstream]` — backlog
- **Where:** `docs/docs/development/`; `@docusaurus/theme-mermaid` installed and unused
- **What's wrong:** Process topology, frame lifecycle and ZMQ topics are undocumented.
- **Fix:** One page with a mermaid diagram and a topic table.
- **Effort:** M
- **Grade lift:** C+ → B−

#### H5 — Deploy and rollback runbook for the fork image `[fork]` — backlog
- **Where:** `fork/README.md` (build and test only)
- **What's wrong:** Nothing tells the owner how to switch a Frigate stack to `ghcr.io/jtn0123/frigate:<tag>` and back, or what to check after.
- **Fix:** Docs only; agents never execute it.
- **Effort:** S
- **Grade lift:** C+ → C+ (operational clarity)

---

## I — Developer Experience & Tooling — B

Up from C+. Pre-commit (ruff, gitleaks, eslint, prettier) is installed, CI
caches npm and pip, `make` has inner-loop targets, a thin backend test image
replaces the full build for tests, mypy strictness returned for `frigate.stats`,
ruff enforces bandit rules, and "Fork - Checks" mirrors every gate. Held at B:
mypy still ignores most of the backend, a full image build takes ~40 minutes,
there is no way to run the real app locally without the live server, and
nothing tracks upstream automatically.

- ~~I1~~ ✓ done 2026-09-10 — `.pre-commit-config.yaml`, CI caching
- ~~I2~~ ✓ done 2026-09-10 — `make test-py check-py lint format test-web e2e dev-web`
- ~~I4~~ ✓ done 2026-09-10 — ruff `S`, `.pylintrc` removed

#### I6 — Upstream-sync bot `[fork]`
- **Where:** `.github/workflows/` (no scheduled sync); `dev` is updated by hand
- **What's wrong:** A fork dies when rebases pile up; today nobody notices upstream moving (including 0.18.0 final).
- **Fix:** `fork-upstream-sync.yml`: daily fast-forward of `dev`, trial rebase of `main` onto it pushed to `sync/upstream` with "Fork - Checks" dispatched, and one issue per event (clean, conflicted files, new `v*` tag). Never pushes `main`.
- **Effort:** M
- **Grade lift:** B → B+ (keeps the fork alive)

#### ~~I7~~ ✓ done 2026-09-10 — Local demo stack `[fork]`
- **Where:** `fork/` (no way to run the fork's UI against a real backend except pointing `make dev-web` at a live server)
- **What's wrong:** Features are validated only against mocks; dogfooding, CSP tuning (E6), profiling (G11) and web-vitals (G12) have nowhere to run.
- **Fix:** `fork/demo/` compose on the multi-arch rc2 image with `frigate/`, `migrations/`, `web/dist` overlaid, 2–3 looping sample cameras, CPU detector, `127.0.0.1` ports, `make demo-up/down/logs`.
- **Effort:** M
- **Grade lift:** B → B+ (real-app feedback loop)

#### I3 — Continue the mypy ratchet `[upstream]`
- **Where:** `frigate/mypy.ini` (`ignore_errors = true` for `frigate.api.*`, `config.*`, `util.*`, `video.*`, `detectors.*`, `embeddings.*`, `ptz.*`, `http`, `debug_replay`, `test.*`); `frigate.stats` re-enabled by the fork
- **What's wrong:** Strict flags cover a minority of the backend; all routes are unchecked.
- **Fix:** Smallest module group first (`ptz`, `http`, then `util`), one commit each so the ratchet holds.
- **Effort:** L
- **Grade lift:** B → B+

#### I5 — Finish typed env for the frontend `[fork]`
- **Where:** `web/src/vite-env.d.ts` (no `ImportMetaEnv`; `VITE_GIT_COMMIT_HASH` untyped), `web/.env.example` (no `E2E_PORT`); e2e typecheck (`web/tsconfig.e2e.json`) already done
- **What's wrong:** The last untyped env reads.
- **Fix:** Declare `ImportMetaEnv`; document `E2E_PORT`.
- **Effort:** S
- **Grade lift:** B → B (hygiene)

#### I8 — Overlay image for fast branch builds `[fork]`
- **Where:** `.github/workflows/fork-build.yml` (full image build, ~40 minutes cold); `fork/Dockerfile.test` shows the overlay pattern
- **What's wrong:** Every `main` push waits on a full build even when only Python or web files changed.
- **Fix:** For `main` pushes, layer `frigate/`, `migrations/` and `web/dist` over the upstream image (minutes); keep the full build for `fork/*` tags because F2/F3 change Docker dependencies.
- **Update 2026-09-10:** the owner's server will pull `ghcr.io/jtn0123/frigate:main`, so `main` keeps the full build (the overlay would miss Docker-level changes such as E5's wheel pins). An overlay only fits preview branches; low value until those exist.
- **Effort:** M
- **Grade lift:** B → B

#### ~~I9~~ ✓ done 2026-09-10 — Faster test loop in CI and locally `[fork]`
- **Where:** `.github/workflows/fork-checks.yml`, `fork-build.yml`, `.github/actions/fork-web-setup/`, `fork/scripts/{ci-changes,py-checks}.sh`, `fork/Dockerfile.test`, `web/package.json`
- **Done (2026-09-10):** docs-only commits run only gitleaks; node_modules cached on the lockfile; one incremental typecheck instead of three tsc runs; eslint content cache; the e2e bundle built once and Playwright in three shards; mypy, API spec and unittest in parallel; superseded runs cancelled; a single "Checks passed" job; the image build skips files that never reach the image.
- **Changed from the original fix:** the thin test image is **not** pushed to GHCR. Pulling it would cost the same as pulling the 6.6 GB base it sits on, so it saves nothing. Installing the dev tools before the sources are copied gives the local win (rebuild after a Python edit: ~1 s). `make e2e-changed` became `make check-fast` (I10).
- **Measured (dispatch runs before the merge):** CI wall time 354 s → 206 s warm (246 s when the lockfile changes). The lint + typecheck job went from 68 s to 26 s; the E2E critical path is the 52 s build plus the slowest shard (~135 s). Docs-only commits drop to ~15 s and no image build (was ~9 min).

#### ~~I10~~ ✓ done 2026-09-10 — One-command local gates and ready worktrees `[fork]`
- **Where:** `Makefile` (fork block), `fork/scripts/{check,wt}.sh`, `.pre-commit-config.yaml`, `fork/PLAN.md` workflow
- **Done (2026-09-10):** `make check` runs every CI gate, `make check-fast` only what changed; incremental tsc (17 s → 1.5 s warm) and cached eslint (8 s → 0.7 s warm); CI's pinned ruff through uvx (Homebrew's is older); one test image per worktree; `make wt NAME=x` with an APFS-cloned node_modules (5.5 min, ~no disk, vs 7 min and ~1 GB for `npm ci` on the USB drive) and its own e2e port.
- **Found:** this Mac (16 GB) runs with ~10 GB of swap in use when several agents and Docker are up; parallel Node gates were then 10x slower than the same gates in sequence, so host gates queue and only the Docker gates run beside them.

#### I11 — Toolchain trial: TypeScript 7, Vite 8, Vitest 5 `[fork]` — backlog, first step of the majors phase (F4, last)
- **Where:** `web/package.json`, `web/package-lock.json`; upstream is on TypeScript 5.9, Vite 6, Vitest 3
- **What's wrong:** Typecheck (17 s cold) and `vite build` (30–60 s) are the slowest web steps; TypeScript 7 is the native compiler and Vite 8 bundles with Rolldown.
- **Fix:** A measured trial on a throwaway branch: before/after for typecheck, build, test and e2e, plus a check that typescript-eslint and vite-plugin-monaco-editor still work. Adopt only if the owner accepts the extra `package-lock.json` conflict on each upstream sync.
- **Effort:** S (trial) / M (adopt)
- **Grade lift:** B → B (speed only)

---

## UX feature track

Product features, graded under C (Frontend Quality). Specs for queued items
are in `fork/PLAN.md`. "Backlog" items wait for the owner to promote them.

| ID | Feature | Size | Status |
|----|---------|------|--------|
| ~~UI1~~ | Never a blank page (= C1) | S | ✓ done |
| ~~UI2~~ | Keyboard + screen-reader access (= C2) | M | ✓ done |
| ~~UI3~~ | Faster first paint (= G1/G5, Inter preload) | M | ✓ done |
| ~~UI4~~ | Honest error states (= C5) | S | ✓ done |
| UI5 | Layout follows the viewport (= A1, + D3) | M | queued — features4 |
| UI6 | Command palette (Cmd/Ctrl+K) | S–M | committed on `section/features1`, needs rebase + verify |
| ~~UI7~~ | Settings navigation: scrollspy rail, search, diff before Save All | M | ✓ done |
| UI8 | Timeline scrubber: snap, arrow keys, touch targets | M | queued — features3 |
| UI9 | Shared event summary header (Review + Explore) | M | queued — features3 |
| ~~UI10~~ | Bulk actions in Explore + undo for mark-reviewed | M | ✓ done |
| UI11 | Share a clip: expiring link + QR (small backend) | M | committed on `polish2` |
| UI12 | Camera health cards | M | committed on `section/features1` |
| UI13 | Live layout memory + picture-in-picture | M | queued — features4 |
| UI14 | Notification inbox with quiet hours | M | committed on `section/features1` |
| ~~UI15~~ | Theme controls: density, text size, OLED black | S | ✓ done |
| UI16 | Camera offline alerts (UI12 data → UI14 inbox) | M | queued |
| UI17 | Storage forecast + retention simulator (small backend) | M | queued (owner promoted) |
| UI18 | Installable mobile app polish | M | backlog, long term |
| UI19 | Kiosk / wall-display mode (auto-cycle, burn-in shift, night dim) | M | backlog |
| UI20 | Performance advisor on System page | M | backlog |
| UI21 | Review triage keys (j/k, space, r, e, `?`) | S | backlog |
| UI22 | Morning digest card on Review | S | backlog |
| UI23 | Setup health checklist (auth, admin password, HTTPS, retention) | S | backlog |
| UI24 | Last-event chip on Live tiles | S | backlog |
| UI25 | Tile quick actions (snapshot, mute, detect, PTZ) | S | backlog |
| UI26 | Skip-idle playback + remembered speed | M | backlog |
| UI27 | Swipe to review on mobile | S | backlog |
| UI28 | Activity heatmap (hour × day) | M | backlog |
| UI29 | Date-range filter on Exports (0.18 already has the calendar with activity markers on Review and Explore) | S | backlog — PLAN2 PR-17 |
| UI30 | Connection banner on websocket loss (verify 0.18 first) | S | backlog |
| UI31 | Guided empty states | S | backlog |
| UI32 | Undo for destructive actions (clips, exports) | M | backlog |
| UI33 | Export queue UX (progress, inbox entry, good filenames) | S | backlog |
| UI34 | Saved and recent searches in Explore | S | backlog |
| UI35 | Zone editor UX (snap, undo/redo, numeric entry) | M | backlog |
| UI36 | Reduced motion + high-contrast theme | S | backlog |
| UI37 | Camera-group quick switch | S | backlog |
| UI38 | Copy diagnostics button | S | backlog |
| UI39 | Timeline hover previews (verify 0.18 first) | M | backlog |
| UI40 | Server-side camera-offline push (needs HTTPS on the server) | M | backlog |
| UI41 | Cross-camera stories | L | backlog |
