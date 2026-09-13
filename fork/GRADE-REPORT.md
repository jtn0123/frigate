# Codebase Grade Report

**Project:** frigate — fork `jtn0123/frigate`, branch `next` @ b42105b (base upstream v0.18.0 stable, taken 2026-09-13)
**Audited:** 2026-09-13 (regrade; previous regrade 2026-09-10, baseline audit of upstream `dev` the same morning)
**Stack:** Python 3.11 / FastAPI 0.116 / peewee 3.17 + SQLite (WAL) / pydantic 2.10 / ZMQ multiprocess pipeline, go2rtc + ffmpeg binaries; React 19 / TypeScript 5.9 (strict) / Vite 6 / Tailwind 3 / Radix + shadcn / SWR / react-router 6 / i18next 24; vitest + Playwright + SonarCloud; Debian 12 Docker image, nginx front
**Focus:** frontend (`web/`) — this fork exists for UI/UX work — plus the fork's own operational tooling (`fork/`)
**Method:** static audit of the working tree at b42105b (141 commits since the last regrade). Dependencies are not installed in the audit environment, so no suite was executed; test and gate claims come from the workflow definitions and the last green run.

**How IDs work in this file.** IDs are stable across regrades because commits,
`FORK.md` and `fork/PLAN.md` refer to them. Done items are struck through
with ✓ and kept as one line. New items take the next free number in their
category. Product features live in the **UX feature track** (UI1…) at the
end. `fork/PLAN.md` and then `fork/PLAN2.md` decide the order work happens in;
this file says what each item is.

## Summary

| ID | Category | Baseline | 09-11 | 09-13 audit | After this branch | Open items |
|----|----------|----------|-------|-------------|-------------------|------------|
| A | Architecture & Design | B− | B− | B− | B | 4 |
| B | Backend Quality | B− | B | B | B | 2 |
| C | Frontend Quality | C | C+ | C+ | B− | 5 |
| D | Testing & Reliability | C+ | B− | B | B+ | 5 |
| E | Security | B+ | B+ | A− | A | 0 |
| F | Dependencies & Tech Currency | C+ | B− | B− | B− | 1 |
| G | Performance & Scalability | C+ | B− | B− | B− | 4 |
| H | Documentation & Onboarding | C | C+ | C+ | C+ | 4 |
| I | Developer Experience & Tooling | C+ | B | B+ | B+ | 3 |
| **Overall** | | **B−** | **B** | **B+** | **B+** | **28** + UX track |

**What this branch shipped (2026-09-13).** Thirteen of the fifteen items at the
top of the priority list, one of them (G9) half: A5, B5, C9, D20, D21, E6, E7,
F7, G8, I3 (first wave), I16, I17, and G9's image half. B2 and D6 were
deliberately left. Security reaches A (CSP enforced and re-checked by the
suite, the fork's own locks scanned) and testing B+, but the overall grade
stays B+: documentation is untouched at C+, and performance stays B− until the
card grids are virtualised, which is the half of G9 this branch did not do.

**What moved the overall grade since 2026-09-11.** Security closed its two
open blockers (E4 triage, E5 patches) and gained a SonarCloud quality gate on
every PR into `next`; testing gained coverage on both sides (Python via
`coverage` in the test image, web via vitest plus merged browser coverage from
e2e) and 15 new fork suites; developer experience gained the upstream-sync bot,
the demo stack, release automation and ROCm builds. Nothing regressed, but the
new `fork/` Python codebase (monitoring, audio trial, scripts) arrived without
the guarantees the rest of the repo has: no mypy, no Dependabot on its locks,
and its tests only run in CI's coverage path.

**Top 5 highest-leverage open fixes:** G9 (virtualisation), B2, D6, C7, A6

**Type safety at a glance.** Frontend: TypeScript `strict` (plus
`noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`) gates the build;
escape hatches are held by the CI ratchet (`fork/type-ratchet.json`: 23
explicit `any`, 16 `@ts-expect-error`, 25 `as unknown as`, 25
`no-explicit-any` disables, plus nine type-aware rule counts with
`no-floating-promises` and `no-misused-promises` at 0). The weak seam is
unchanged: hand-written API types in `web/src/types/` and no runtime
validation of responses (A5). Backend: 188 routes, 77 with a `response_model`
(the ratio slipped from 77/179 because the fork's own routers added none, B5);
mypy still has `ignore_errors` for `frigate.api`, `config`, `util`, `video`,
`detectors`, `embeddings`, `ptz` and tests (I3); 143 `type: ignore`; and none
of `fork/` is type-checked at all (I16).

---

## A — Architecture & Design — B−

Unchanged grade. The process model (ZMQ IPC `frigate/comms/zmq_proxy.py`,
shared-memory frames `frigate/app.py`) is still the strongest part, and the
fork's UI code stays in isolated folders behind runtime flags, which keeps
rebases cheap (51 fork TypeScript files). Still held back by god modules (38
frontend files over 800 lines; `web/src/pages/Settings.tsx` 2,354,
`frigate/api/event.py` 2,392), no service layer, UA sniffing for layout (644
`isMobile` / `isDesktop` references), and an untyped client/server contract.
New this round: the fork now carries a second Python codebase under `fork/`
with no package boundary (A6).

- ~~A4~~ ✓ done 2026-09-11 — config fetched once in `App`, passed to `DefaultAppView`

#### A1 — Introduce a viewport hook and retire user-agent layout branching `[fork]` (= UI5)
- **Where:** `web/src/App.tsx`, `components/navigation/{Sidebar,Bottombar,NavItem}.tsx`, `hooks/use-navigation.ts`; 644 `isMobile`/`isDesktop` references
- **What's wrong:** Layout is picked from UA constants evaluated once; narrow desktop windows and rotated tablets get the wrong tree.
- **Fix:** `web/src/hooks/fork/use-viewport.ts` (`matchMedia` + `useSyncExternalStore`) for the shell and navigation only, flag `viewportLayout`; ships with D3. Not a full migration.
- **Effort:** M (scoped)
- **Grade lift:** B− → B− (removes the worst layout bug; the full migration stays out of scope)

- ~~A5~~ ✓ done 2026-09-13 — `web/src/types/fork/api.gen.ts` generated from the spec and CI-checked


#### A6 — Give the fork's Python tooling a package boundary `[fork]` — new 2026-09-13
- **Where:** `fork/monitoring/` (host collectors and incident tracking, 3 test files), `fork/audio_trial/` (worker, queue, telemetry, benchmarks, own Dockerfile and lock, 8 test files), `fork/scripts/` (CI helpers); each is a flat directory of modules imported by path, with `python3 -m unittest discover -s <dir>` as the only entry point
- **What's wrong:** ~3,000 lines of Python that ships nothing to the image but is now load-bearing for operations, with no package layout, no shared conftest or fixtures, no type checking (I16), and three separate dependency sets (F7). Imports work only because the discovery directory happens to be on `sys.path`, so moving a file breaks callers silently.
- **Fix:** One `fork/` package per tool with `__init__.py` and console entry points, a single dev lock, and discovery by package name; no behaviour change. Do it before a fourth tool lands.
- **Effort:** M
- **Grade lift:** B− → B− (keeps the tooling from becoming a second untested codebase)

#### A2 — Split `ws.ts` into transport, state diffing and hooks `[fork]` — backlog
- **Where:** `web/src/api/ws.ts` (886 lines)
- **What's wrong:** Protocol parsing, camera-activity diffing and ~50 hooks share one file.
- **Fix:** `web/src/api/ws/{store,protocol,hooks}.ts`, `ws.ts` re-exports.
- **Effort:** S
- **Grade lift:** B− → B− (testability, conflict surface)

#### A3 — Add a service layer for the largest routers `[upstream]` — backlog
- **Where:** `frigate/api/event.py` (2,392), `media.py` (1,862), `camera.py`, `app.py`
- **What's wrong:** Handlers hold business logic and query peewee directly.
- **Fix:** `frigate/services/<domain>.py`, one router at a time.
- **Effort:** L
- **Grade lift:** B− → B

---

## B — Backend Quality — B

Unchanged grade. One error shape reaches every client (B1), silent exception
swallows log (B3), handlers do not block the event loop (G3), every route
declares exactly one auth gate checked at startup (E2), and this round's Sonar
campaigns cleared several hundred reliability findings across the backend.
Held at B because the typed-response gap grew rather than shrank: 111 of 188
routes still return raw dicts, and the fork's own two routers added none.

- ~~B1~~ ✓ done 2026-09-10 — HTTPException renders `{success, message, detail}`
- ~~B3~~ ✓ done 2026-09-10 — 25 `except Exception: pass` sites log; bare `except:` narrowed

#### B2 — Declare `response_model` on the remaining 111 routes `[upstream]` — backlog
- **Where:** `frigate/api/*.py` (77 of 188 routes covered); models in `frigate/api/defs/response/`
- **What's wrong:** Well over half the API is untyped in the OpenAPI spec, which also caps A5.
- **Fix:** Add pydantic response models, frontend-heaviest routes first (`review`, `events`, `config`, `stats`).
- **Effort:** L
- **Grade lift:** B → B+

- ~~B5~~ ✓ done 2026-09-13 — response models on `/fork/share` and `/fork/updates`; spec regenerated


#### B4 — Declare indexes on models, not only in migrations `[upstream]` — backlog
- **Where:** `migrations/011`, `020`, `022`, `027` vs `frigate/models.py`
- **What's wrong:** Models under-document the real schema.
- **Fix:** Matching `class Meta: indexes`; migrations stay authoritative.
- **Effort:** S
- **Grade lift:** B → B (hygiene)

---

## C — Frontend Quality — C+

Unchanged grade. This round cleared the SonarCloud findings in fork-added web
files (C12) and a batch of upstream ones, and the type ratchet now guards every
escape hatch. The three things holding C+ are all still open: jsx-a11y is
advisory (every recommended rule is `warn` in `web/eslint.config.js`, C9), 107
`exhaustive-deps` suppressions remain of 167 `eslint-disable` comments (C7),
and the Settings save transaction is still inline and untested (C3). New this
round: the fork's own UI ships English-only (C13).

- ~~C1~~ ✓ 2026-09-10 — route error boundary, chunk-load recovery
- ~~C2~~ ✓ 2026-09-10 — jsx-a11y lint, 42 role/tabIndex sites, 27 real buttons, 16 alt texts
- ~~C5~~ ✓ 2026-09-10 — SWR read-error toasts + `ErrorState`
- ~~C8~~ ✓ 2026-09-10 — sandbox gated to dev
- ~~C10~~ ✓ 2026-09-11 — TypeScript escape hatches ratcheted in CI
- ~~C11~~ ✓ 2026-09-11 — floating and misused promises are errors (269 → 0)
- ~~C12~~ ✓ 2026-09-11 — 45 of 46 SonarCloud findings in fork web files cleared

- ~~C9~~ ✓ done 2026-09-13 — every jsx-a11y rule is an error (a clean run reported zero findings)


#### C3 — Extract the Settings "Save All" transaction into a tested module `[fork]`
- **Where:** `web/src/pages/Settings.tsx` (2,354 lines) save path
- **What's wrong:** The riskiest UI logic is inline and unit-untested; UI7's diff dialog builds on it and only e2e covers it.
- **Fix:** Local split only: `web/src/lib/fork/settings-save.ts` with vitest for ordering, partial failure and restart-required.
- **Effort:** M
- **Grade lift:** C+ → C+ (risk reduction)

#### C13 — Translate the fork's UI strings `[fork]` — new 2026-09-13
- **Where:** `web/public/locales/en/fork.json` (220 keys) is the only `fork.json`; the other 40 locale directories have none
- **What's wrong:** Every fork feature (command palette, camera health, inbox, appearance, share, update notices, settings nav) falls back to English for non-English users, in an app whose upstream is fully translated. `CLAUDE.md` requires `t()` and the code obeys it, so the strings exist but land untranslated.
- **Fix:** Decide the policy and write it down: either machine-translate the 220 keys into the top locales with a fork script and let Crowdin correct them later, or state in `FORK.md` that fork UI is English-only and hide the affected entry points from non-English builds. Silence is the worst option.
- **Effort:** S (policy + script) / M (full coverage)
- **Grade lift:** C+ → C+ (reach; removes a visible quality gap)

#### C4 — Kill four-level prop drilling in Events → EventView → DetectionReview → MotionReview `[fork]` — backlog
- **Where:** `web/src/pages/Events.tsx` → `views/events/EventView.tsx` (1,765) → `SearchDetailDialog.tsx` (1,914)
- **Fix:** `ReviewPageContext`; only as a local split when a feature touches these files.
- **Effort:** M
- **Grade lift:** C+ → B−

#### C6 — Break up the three worst god components `[fork]` — backlog
- **Where:** `views/live/LiveCameraView.tsx` (1,812), `views/motion-search/MotionSearchView.tsx` (1,645), `components/overlay/detail/SearchDetailDialog.tsx` (1,914)
- **Fix:** Controller hook + sub-component folder, one file at a time, only when a feature needs it.
- **Effort:** L
- **Grade lift:** C+ → B−

#### C7 — Reduce the 107 `exhaustive-deps` suppressions `[fork]` — backlog
- **Where:** `web/src` (167 `eslint-disable`, 107 for `react-hooks/exhaustive-deps`)
- **What's wrong:** Deliberately stale closures whose correctness depends on comments.
- **Fix:** Stable callbacks or derived state; CI count ratchet like C10.
- **Effort:** M
- **Grade lift:** C+ → B−

---

## D — Testing & Reliability — B

Up from B−. Both sides now report coverage: Python runs under `coverage` in
the thin test image and web merges vitest coverage with measured browser
coverage from the e2e run, and both feed a SonarCloud quality gate that blocks
PRs into `next`. Volume grew too: 100 backend test files / 1,113 test
functions, 249 web unit cases, 278 e2e cases across 41 specs, plus 94 test
functions in the fork's own tooling. Nine reliability items found on the
owner's server (D10–D18) are fixed with tests. Held at B rather than B+: no
coverage floor is enforced anywhere (D21), the tracking pipeline still has no
unit tests (D4), there are no visual regression baselines (D6), and the fork's
tooling tests only execute on CI's coverage path (D20).

- ~~D1~~ ✓ 2026-09-10 — vitest set-up, CI step
- ~~D2~~ ✓ 2026-09-11 — e2e for Settings save, camera wizard, zone editing, motion search
- ~~D5~~ ✓ 2026-09-10 — web coverage uploaded
- ~~D8~~ ✓ 2026-09-12 — Python coverage in CI (`coverage run -m unittest` in `frigate-fork-test`, XML to Sonar)
- ~~D10~~ ✓ 2026-09-11 — software-decode fallback after repeated hardware-decode crashes
- ~~D11~~ ✓ 2026-09-11 — camera restarts tracked with a reason; log flooding stopped
- ~~D12~~ ✓ 2026-09-11 — no doubled punctuation on repeat ffmpeg-exit warnings
- ~~D13~~ ✓ 2026-09-11 — unambiguous circular-progress timings
- ~~D14~~ ✓ 2026-09-11 — Camera Health reports lasting trouble only; fallback remembered 7 days
- ~~D15~~ ✓ 2026-09-11 — frame-rate chart seeded from `/stats/history`, scaled from zero
- ~~D16~~ ✓ 2026-09-11 — layout-only e2e selected by tag, not run-time skip
- ~~D17~~ ✓ 2026-09-11 — ctranslate2 loaded before onnxruntime (ROCm transcription crash loop)
- ~~D18~~ ✓ 2026-09-11 — Ollama per-image token cost measured, not guessed

- ~~D21~~ ✓ done 2026-09-13 — line coverage compared with `fork/coverage-floor.json` in the Sonar job


#### D6 — Visual regression screenshots `[FE] [fork]`
- **Where:** `web/e2e/playwright.config.ts` (no `toHaveScreenshot` anywhere); fork UI in `web/src/components/fork/`, `themes/fork-appearance.css`
- **What's wrong:** A rebase or dependency bump can silently undo polish (spacing, OLED theme, density) and every functional test still passes. The 0.18.0 stable rebase this round was exactly that kind of event.
- **Fix:** A `visual` project, ~8 views × desktop/mobile on mocked data, dynamic regions masked, `maxDiffPixelRatio` ≈ 0.01; Linux baselines produced by a `workflow_dispatch` input that uploads them as an artifact.
- **Effort:** M
- **Grade lift:** B → B (protects every C and UX gain)

#### D3 — Add a tablet viewport to the e2e matrix `[FE] [fork]`
- **Where:** `web/e2e/playwright.config.ts` (desktop 1920×1080 and phone 390×844 only)
- **What's wrong:** The 700–1,100 px range, where UA layout breaks, is untested.
- **Fix:** 1024×768 project; ships with A1.
- **Effort:** S
- **Grade lift:** B → B (prerequisite for A1)

#### D9 — Validate e2e mock fixtures against the API spec `[FE] [fork]`
- **Where:** `web/e2e/fixtures/` (hand-built JSON payloads), `docs/static/frigate-api.yaml`
- **What's wrong:** Mocks can drift from the real API after an upstream rebase and the e2e suite keeps passing against a shape the server no longer sends.
- **Fix:** Validate every fixture against the spec's response schemas in the e2e setup (ships with A5).
- **Effort:** S
- **Grade lift:** B → B (test fidelity)

#### D4 — Test the core tracking pipeline `[BE] [upstream]` — backlog
- **Where:** `frigate/track/object_processing.py`, `frigate/comms/dispatcher.py`
- **What's wrong:** The detection-to-event path, the heart of the product, has no unit tests.
- **Fix:** Fixture-driven synthetic detections through `TrackedObjectProcessor`.
- **Effort:** M
- **Grade lift:** B → B+

#### D7 — Refresh e2e mocks from real responses `[FE] [fork]` — backlog
- **Where:** `web/e2e/fixtures/` (hand-built mock payloads); the I7 demo stack can now produce real ones
- **Fix:** Record responses from the demo stack into fixtures with a script; diff on rebase.
- **Effort:** S
- **Grade lift:** B → B (fidelity)

---

## E — Security — A−

Up from B+, the largest move this round. The two blockers are closed: every
CodeQL finding was traced (E4 — all in upstream code or disabled workflows,
fixed or dismissed with a written reason) and the shipped advisories were
patched (E5 — `python-multipart`, axios, react-router-dom and the rest of the
web lock). On top of the structural work already in place (E1 headers and
HSTS, E2 one auth gate per route with a startup assertion, E3 `safe_join`),
the repo now runs secret scanning with push protection, gitleaks in CI and
hooks, CodeQL, Dependabot alerts with grouped security PRs, branch rulesets,
hash-locked pip installs (`--require-hashes --only-binary :all:`),
`npm ci --ignore-scripts`, SHA-pinned actions and checksummed binary
downloads, plus a SonarCloud security gate whose findings were worked through
in six documented rounds. Short of A only because CSP is still report-only and
the fork's own supply chain has an unwatched corner (F7).

- ~~E1~~ ✓ 2026-09-10 — security headers, HSTS in every `add_header` location, CSP report-only
- ~~E2~~ ✓ 2026-09-10 — one auth gate per route, startup assertion + test
- ~~E3~~ ✓ 2026-09-10 — `safe_join` in `preview_thumbnail`
- ~~E4~~ ✓ 2026-09-11 — CodeQL criticals and highs traced; fixed or dismissed with reasons
- ~~E5~~ ✓ 2026-09-11 — shipped advisories patched in the image and the web lock

- ~~E6~~ ✓ done 2026-09-13 — CSP enforced, with an e2e pass behind the same policy (`E2E_CSP=1`)


- ~~E7~~ ✓ done 2026-09-13 — pip-audit over the fork's three locks, with reviewed exceptions that expire when unreported


---

## F — Dependencies & Tech Currency — B−

Unchanged grade. Shipped advisories are patched (E5), a dormant dependency is
gone and the rest are documented (F5), minors and patches were refreshed within
current majors (F6), binary downloads are checksummed and actions pinned (F2),
and the wheel set is clean (F3). Still B− because the frontend majors are
deliberately last (F4: Tailwind 3, react-router 6, i18next 24, apexcharts 3,
date-fns 3, vite 6), numpy stays pinned to 1.26, and the fork's three new pinned
requirement files are outside Dependabot's watch (F7).

- ~~F1~~ ✓ 2026-09-10 — ESLint 9 flat config
- ~~F2~~ ✓ 2026-09-10 — go2rtc/ffmpeg SHA256, py3nvml commit pin, pinned actions
- ~~F3~~ ✓ 2026-09-10 — mypy out of runtime, single `opencv-contrib-python-headless`
- ~~F5~~ ✓ 2026-09-11 — `sort-by` removed, remaining dormant deps documented
- ~~F6~~ ✓ 2026-09-11 — minor/patch refresh within majors

- ~~F7~~ ✓ done 2026-09-13 — Dependabot on `/fork` and `/fork/audio_trial`, plus a lock-drift check


#### F4 — Frontend major bumps `[fork]` — backlog, scheduled last (owner OK 2026-09-11)
- **Where:** `web/package.json`: ~34 packages a major behind (toolchain: TypeScript, Vite, Vitest, jsdom; runtime: react-router, i18next, date-fns, zod, apexcharts, lucide, framer-motion, tailwind-merge)
- **What's wrong:** One or more majors behind each; a few carry open Dependabot alerts that only the next major fixes.
- **Fix:** Last phase, after the debugging and type-safety blocks: one PR per major (or tightly coupled group). Toolchain first (I11), then runtime libraries by alert and risk, Tailwind 4 last.
- **Effort:** L
- **Grade lift:** B− → B

---

## G — Performance & Scalability — B−

Unchanged grade, but the wins are now defended: eager JS+CSS is 353 kB gzip
and `fork/bundle-budget.json` fails CI above 371 kB (G7), so the 504 → 353 kB
result cannot erode one import at a time. Async handlers no longer block (G3),
event search is bounded in SQL (G4), and the recording maintainer stopped
walking the host process table (G6). The remaining costs are unchanged and
measurable: no list is virtualised anywhere, 24 of 34 `<img>` still load
eagerly, the Settings form chunk carries a runtime schema compiler, hashed
assets are not `immutable`, and summary endpoints have no HTTP caching.

- ~~G1~~ ✓ 2026-09-10 — explicit icon map, lazy settings menus
- ~~G2~~ ✓ 2026-09-10 — SWR global policy
- ~~G3~~ ✓ 2026-09-10 — sync handlers are `def`, awaited ones use `asyncio.to_thread`
- ~~G4~~ ✓ 2026-09-10 — SQL ORDER BY/LIMIT, bounded vector candidates, windowed review join
- ~~G5~~ ✓ 2026-09-10 — lazy players, `manualChunks`, memoised cards (virtualisation → G9)
- ~~G6~~ ✓ 2026-09-10 — `frigate/record/cache_tracker.py`
- ~~G7~~ ✓ 2026-09-11 — eager-bundle budget enforced in CI

#### G9 — Virtualise the card grids `[fork, upstreamable]` — images half done 2026-09-13
- **Where:** `web/src/views/search/SearchView.tsx`, `views/events/EventView.tsx`, `views/recording/RecordingView.tsx` (infinite scroll keeps every card mounted; no virtualisation library in `package.json`)
- **Done (2026-09-13):** every thumbnail in a scrolling list carries `decoding="async"`, and the ones that did not defer now carry `loading="lazy"`. The single in-view images (dialogs, wizards, players) stay eager on purpose.
- **What's wrong:** Long Review/Explore sessions grow the DOM and image memory without bound; offscreen thumbnails compete with visible ones. Still the largest runtime win available anywhere in this report.
- **Fix:** `@tanstack/react-virtual` (small, no peer majors) for the three grids behind a flag; add `loading="lazy" decoding="async"` to non-critical images. The image half is an afternoon and can ship first.
- **Effort:** M
- **Grade lift:** B− → B

- ~~G8~~ ✓ done 2026-09-13 — the ajv validator streams beside the settings chunk (882 kB → 635 kB raw)


#### G10 — Immutable, precompressed static assets `[upstream]`
- **Where:** `docker/main/rootfs/usr/local/nginx/conf/nginx.conf` (`/assets/` has `expires 1y` + `Cache-Control "public"`, no `immutable`; gzip on the fly, no `gzip_static`)
- **What's wrong:** Reloads revalidate every hashed chunk; nginx recompresses the same files per request.
- **Fix:** `Cache-Control: public, max-age=31536000, immutable` for `/assets/`; emit `.gz` at build and enable `gzip_static`.
- **Effort:** S
- **Grade lift:** B− → B− (repeat-visit latency, server CPU)

#### G11 — HTTP caching for summary endpoints `[upstream]`
- **Where:** `frigate/api/review.py` (`review_summary`), `frigate/api/record.py` (`all_recordings_summary`, `recordings_summary`); zero `ETag`/`Last-Modified` handling in `frigate/api/`
- **What's wrong:** Summaries are recomputed and re-sent on every poll and focus even when nothing changed.
- **Fix:** Profile in the demo stack; then an ETag from the newest relevant row timestamp with a 304 path.
- **Effort:** M
- **Grade lift:** B− → B− (API load under many clients)

#### G12 — Web-vitals budget on key pages `[fork]` — backlog
- **Where:** no LCP/INP/CLS measurement anywhere; the demo stack (I7) can host it now
- **What's wrong:** Bundle size is a proxy; real interaction latency is unmeasured.
- **Fix:** Lighthouse CI (or `web-vitals` in a Playwright run) against the demo stack; fail on regression.
- **Effort:** M
- **Grade lift:** B− → B−

---

## H — Documentation & Onboarding — C+

Unchanged grade, and the weakest category relative to the work it describes.
Wrong statements are fixed (H1), CONTRIBUTING lists every CI gate (H2), and
the fork's ledger, plans and this report are current. But the frontend still
has a 25-line README for ~139k lines of TypeScript, there is no e2e or patches
README, no architecture page, and this round added nine `fork/SONAR-*.md`
files plus three issue CSVs with no index (H6). The fork's process
documentation is now larger than its onboarding documentation.

- ~~H1~~ ✓ 2026-09-10 — Python version, React 19, proxy host, vitest and compose syntax corrected
- ~~H2~~ ✓ 2026-09-10 — CONTRIBUTING lists every CI gate

#### H6 — Consolidate the SonarCloud paper trail `[fork]` — new 2026-09-13
- **Where:** `fork/SONAR-{BLOCKERS-SECURITY,CI,DOWNLOAD-SECURITY,FIX-TRACKER,ROUND2-FIXES,ROUND3-FIXES,SECURITY-RELIABILITY,TIER-ONE-TWO,WARNING-CLEANUP}.md` and `fork/sonar-*.csv` (three exports)
- **What's wrong:** Six campaign rounds each left their own file, so nobody can answer "is finding X handled?" without reading nine documents, and none of them is referenced from `FORK.md` or this report. The work was real and thorough; the record of it is not usable.
- **Fix:** One `fork/SONAR.md`: current gate configuration, the standing exclusions and why, a table of rounds with dates and outcomes, and a short list of deliberate exceptions. Archive the round files under `fork/archive/` or delete them (git keeps them) and drop the CSV exports, which are point-in-time and already stale.
- **Effort:** S
- **Grade lift:** C+ → B− (with H3)

#### H3 — Frontend, e2e and patches READMEs `[fork]`
- **Where:** `web/README.md` (25 lines), no `web/e2e/README.md`, no `web/patches/README.md`
- **What's wrong:** Directory rules, the base-path sentinel, e2e mocking and tags, the i18n workflow and the two Radix patches are undocumented, and the e2e suite is now 41 specs deep.
- **Fix:** Write the three READMEs.
- **Effort:** S
- **Grade lift:** C+ → B−

#### H5 — Deploy and rollback runbook for the fork image `[fork]`
- **Where:** `fork/README.md` (build and test only); the fork now publishes amd64 and ROCm images plus GitHub Releases
- **What's wrong:** Nothing tells the owner how to switch a stack to `ghcr.io/jtn0123/frigate:<tag>` and back, or what to check after. This got more urgent, not less: there are two image variants and an in-app update notice pointing at them.
- **Fix:** Docs only; agents never execute it.
- **Effort:** S
- **Grade lift:** C+ → C+ (operational clarity)

#### H4 — Architecture page `[upstream]` — backlog
- **Where:** `docs/docs/development/`; `@docusaurus/theme-mermaid` installed and unused
- **What's wrong:** Process topology, frame lifecycle and ZMQ topics are undocumented.
- **Fix:** One page with a mermaid diagram and a topic table.
- **Effort:** M
- **Grade lift:** C+ → B−

---

## I — Developer Experience & Tooling — B+

Up from B, the round's other big move. The fork now maintains itself: a daily
upstream-sync bot with trial rebases and issues (I6), a local demo stack (I7),
releases from `main` with generated notes (I13), ROCm images (I15), a thin
test image with parallel mypy/spec/unittest lanes, `make check` / `check-fast`,
pre-commit, CI caching, a type ratchet, a bundle budget and a SonarCloud gate.
The 0.18.0 stable rebase landed the same day upstream tagged it, which is the
proof the machinery works. Held short of A− by the two typing gaps: mypy still
ignores most of the backend (I3) and none of `fork/` (I16), and the local
gates drift from CI (D20).

- ~~I1~~ ✓ 2026-09-10 — pre-commit, CI caching
- ~~I2~~ ✓ 2026-09-10 — `make` inner-loop targets
- ~~I4~~ ✓ 2026-09-10 — ruff bandit rules, `.pylintrc` removed
- ~~I5~~ ✓ 2026-09-11 — typed `ImportMetaEnv`, documented `E2E_PORT`
- ~~I6~~ ✓ 2026-09-11 — daily upstream-sync bot with trial rebase and issues
- ~~I7~~ ✓ 2026-09-10 — local demo stack
- ~~I9~~ ✓ 2026-09-10 — faster CI (354 s → 206 s warm; docs-only ~15 s)
- ~~I10~~ ✓ 2026-09-10 — `make check` / `check-fast`, worktrees
- ~~I12~~ ✓ 2026-09-11 — actionlint SC2016 silenced in the sync workflow
- ~~I13~~ ✓ 2026-09-11 — releases from `main` with generated notes
- ~~I14~~ ✓ 2026-09-11 — SonarCloud findings in fork CI, scripts and backend cleared
- ~~I15~~ ✓ 2026-09-11 — ROCm image in the release workflow; runner disk reserve

- ~~I16~~ ✓ done 2026-09-13 — `fork/mypy.ini`, strict with no ignore sections; 85 findings fixed


#### I3 — Continue the mypy ratchet `[upstream]` — first wave done 2026-09-13
- **Where:** `frigate/mypy.ini` (`ignore_errors = true` for `frigate.api.*`, `config.*`, `detectors.*`, `embeddings.*`, `ptz.*`, `test.*`, `util.*`, `video.*`); `frigate.stats` and `frigate.debug_replay` already re-enabled by the fork
- **Done (2026-09-13):** the 30 modules inside those packages that already pass the strict flags are checked per module (most of `frigate.config`, four `frigate.util` modules, the embeddings helpers, `frigate.video.restart_log` and `hwaccel_fallback`). Measured cost of the rest: `video.ffmpeg` 43, `video.detect` 36, `ptz.autotrack` 185, `api.event` 105, `api.media` 69.
- **What's wrong:** Strict flags still skip the large packages, including every route handler, so 143 `type: ignore` comments sit in code that mypy mostly is not reading.
- **Fix:** Remaining waves: `ptz`+`video`, then `config`, `util`, `detectors`+`embeddings`, `api` last, one PR each so the ratchet holds. Never enable mypy on `frigate.test`.
- **Effort:** L
- **Grade lift:** B+ → A− (with I16)

- ~~I17~~ ✓ done 2026-09-13 — `fork/scripts/targets.sh` is the one list CI, the Makefile and check.sh read


#### I8 — Overlay image for fast branch builds `[fork]` — backlog
- **Where:** `.github/workflows/fork-build.yml` (full image build, ~40 minutes cold)
- **What's wrong:** Every `main` push waits on a full build even when only Python or web files changed.
- **Update 2026-09-10:** `main` keeps the full build because the server pulls it and Docker-level changes must be included; an overlay only fits preview branches, which do not exist yet.
- **Effort:** M
- **Grade lift:** B+ → B+

#### I11 — Toolchain trial: TypeScript 7, Vite 8, Vitest 5 `[fork]` — backlog, first step of the majors phase (F4, last)
- **Where:** `web/package.json`, `web/package-lock.json`
- **What's wrong:** Typecheck and `vite build` are the slowest web steps; TypeScript 7 is the native compiler and Vite 8 bundles with Rolldown.
- **Fix:** A measured trial on a throwaway branch: before/after for typecheck, build, test and e2e, plus a check that typescript-eslint and `vite-plugin-monaco-editor` still work.
- **Effort:** S (trial) / M (adopt)
- **Grade lift:** B+ → B+ (speed only)

---

## UX feature track

Product features, graded under C (Frontend Quality). Specs for queued items
are in `fork/PLAN.md`. "Backlog" items wait for the owner to promote them.
Sixteen of the 42 are shipped, all of them behind flags in `web/src/fork/flags.ts`.

| ID | Feature | Size | Status |
|----|---------|------|--------|
| ~~UI1~~ | Never a blank page (= C1) | S | ✓ done |
| ~~UI2~~ | Keyboard + screen-reader access (= C2) | M | ✓ done |
| ~~UI3~~ | Faster first paint (= G1/G5, Inter preload) | M | ✓ done |
| ~~UI4~~ | Honest error states (= C5) | S | ✓ done |
| UI5 | Layout follows the viewport (= A1, + D3) | M | queued — features4 |
| ~~UI6~~ | Command palette (Cmd/Ctrl+K) | S–M | ✓ done |
| ~~UI7~~ | Settings navigation: scrollspy rail, search, diff before Save All | M | ✓ done |
| ~~UI8~~ | Timeline scrubber: snap, arrow keys, touch targets | M | ✓ done |
| ~~UI9~~ | Shared event summary header (Review + Explore) | M | ✓ done |
| ~~UI10~~ | Bulk actions in Explore + undo for mark-reviewed | M | ✓ done |
| ~~UI11~~ | Share a clip: expiring link + QR (small backend) | M | ✓ done |
| ~~UI12~~ | Camera health cards | M | ✓ done (hardened by D14/D15) |
| UI13 | Live layout memory + picture-in-picture | M | queued — features4 |
| ~~UI14~~ | Notification inbox with quiet hours | M | ✓ done |
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
| UI29 | Date-range filter on Exports | S | backlog — PLAN2 PR-17 |
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
| ~~UI42~~ | Update notices and What's new from the fork's releases | M | ✓ done |
