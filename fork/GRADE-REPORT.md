# Codebase Grade Report

**Project:** frigate (fork jtn0123/frigate, branch `dev` @ 77a66e75c, v0.18.0-rc2)
**Audited:** 2026-09-10
**Stack:** Python 3.11 / FastAPI / peewee+SQLite / pydantic v2 / ZMQ multiprocess pipeline; React 19 / TypeScript 5.9 / Vite 6 / Tailwind 3 / Radix+shadcn / SWR / react-router 6 / i18next; Playwright e2e; Debian 12 Docker image
**Focus:** frontend (`web/`) — this fork exists for UI/UX work

## Summary

| ID | Category | Grade | Items |
|----|----------|-------|-------|
| A | Architecture & Design | B− | 4 |
| B | Backend Quality | B− | 4 |
| C | Frontend Quality | C | 8 |
| D | Testing & Reliability | C+ | 5 |
| E | Security | B+ | 3 |
| F | Dependencies & Tech Currency | C+ | 5 |
| G | Performance & Scalability | C+ | 5 |
| H | Documentation & Onboarding | C | 4 |
| I | Developer Experience & Tooling | C+ | 5 |
| **Overall** | | **B−** | **43** |

**Top 5 highest-leverage fixes:** C1, D1, G1, C3, I1

**Fork-specific note.** Items tagged `[fork]` are the ones that matter for a UI-polish fork and are low-conflict with upstream. Items tagged `[upstream]` are worth sending upstream as PRs rather than carrying in the fork.

---

## A — Architecture & Design — B−

Deliberate, well-separated process model: long-lived subprocesses talk over ZMQ Unix IPC (`frigate/comms/zmq_proxy.py:11-25`) and frames move through named shared memory (`frigate/app.py:356-372`), so nothing pickles video. The config tree is decomposed by domain (`frigate/config/camera/*.py` each under 200 lines). It loses points for god modules on both sides (`frigate/api/event.py` 2301 lines; `web/src/pages/Settings.tsx` 2366 lines), no service layer between routers and peewee models, 27 function-local imports used as cycle breakers, and a frontend whose responsive layout is decided by user-agent constants at import time.

#### A1 — Introduce a viewport hook and retire user-agent layout branching `[fork]`
- **Where:** `web/src/App.tsx:6,73-84`; 240 `isMobile` / 374 `isDesktop` references across 102 files (`react-device-detect`)
- **What's wrong:** Layout is chosen from UA-sniffed module constants evaluated once. A narrow desktop window or a rotated tablet keeps the wrong tree. It forces duplicated mobile/desktop JSX branches, which is the main driver of the god-component sizes. `web/e2e/playwright.config.ts:8-11` has to spoof UA strings, not just viewports.
- **Fix:** Add `web/src/hooks/use-is-mobile.ts` backed by `matchMedia` + `useSyncExternalStore` with the same boolean API. Migrate `App.tsx` and `Sidebar`/`Bottombar` first, then the top views; convert cosmetic branches to Tailwind `md:`/`lg:` classes. Keep `react-device-detect` only for capability checks (`isIOS`, `isSafari`, PWA).
- **Effort:** L
- **Grade lift:** B− → B (removes the single largest structural coupling in the frontend)

#### A2 — Split `ws.ts` into transport, state diffing, and hooks `[fork]`
- **Where:** `web/src/api/ws.ts` (886 lines): transport parsing `:59-155`, camera-activity diffing `:156-230`, ~50 hooks `:272-880`
- **What's wrong:** The best-engineered module in the frontend has no internal boundary. Any UI change that needs a new topic hook edits the same file as protocol parsing, which guarantees rebase conflicts with upstream.
- **Fix:** Move to `web/src/api/ws/{store.ts,protocol.ts,hooks.ts}` with `ws.ts` re-exporting. Pure functions in `protocol.ts` become unit-testable (see D1).
- **Effort:** S
- **Grade lift:** B− → B− (enables D1 and lowers conflict surface; no grade change alone)

#### A3 — Add a service layer for the largest routers `[upstream]`
- **Where:** `frigate/api/event.py` (2301), `frigate/api/media.py` (1829), `frigate/api/app.py:288-370` (inline config redaction), `frigate/api/camera.py` (1430)
- **What's wrong:** Handlers query peewee directly and hold business logic (redaction, ffmpeg command construction, profile merging). Tests have to mock `sys.modules` to import them (`frigate/test/test_maintainer.py:8-16`).
- **Fix:** Extract per-domain modules under `frigate/services/` (start with config redaction and event search), routers call them. One router at a time.
- **Effort:** L
- **Grade lift:** B− → B

#### A4 — Retire the duplicated `useSWR("config")` and dead wrappers in the app shell `[fork]`
- **Where:** `web/src/App.tsx:35,51` (same SWR key fetched in parent and child), `web/src/App.tsx:107-108` (stray `{" "}` text nodes inside `<Routes>`), `web/src/api/index.tsx:53-55` (`WsWithConfig` pass-through)
- **What's wrong:** Small, but this is the file every fork change touches. Noise here costs a conflict on every rebase.
- **Fix:** Fetch config once in `App`, pass down or rely on the SWR cache; delete `WsWithConfig`; remove the stray text nodes.
- **Effort:** S
- **Grade lift:** B− → B− (hygiene)

---

## B — Backend Quality — B−

Seventeen routers registered cleanly in `frigate/api/fastapi_app.py:16-30`, 35 consistent peewee migrations, and only 27 TODO/FIXME across 97k lines. Against that: 488 `JSONResponse` calls vs 13 `HTTPException` means two competing error shapes; only 77 of 181 routes declare `response_model`; 311 `except Exception` with 26 silent `pass`; pagination is limit-only and applied in Python after fetching every row (`frigate/api/event.py:884`).

#### B1 — Unify error response shape `[upstream]`
- **Where:** `frigate/api/*.py` (488 `JSONResponse({"success": false, "message": ...})` vs FastAPI `{"detail": ...}` at `frigate/api/auth.py:155,1126`)
- **What's wrong:** Clients, including the fork's own frontend, must handle two error formats. Frontend toasts read `message` and silently miss `detail`.
- **Fix:** One `ApiError` exception + handler in `fastapi_app.py` that emits `{"success": false, "message": ..., "detail": ...}`. Migrate routers file by file.
- **Effort:** M
- **Grade lift:** B− → B

#### B2 — Declare `response_model` on the remaining 104 routes `[upstream]`
- **Where:** `frigate/api/` (77/181 covered); models already exist in `frigate/api/defs/response/`
- **What's wrong:** Untyped raw-dict responses mean the OpenAPI spec (`docs/static/frigate-api.yaml`) under-describes half the API, and the frontend types in `web/src/types/` are hand-maintained rather than generated.
- **Fix:** Add pydantic response models, prioritising routes the frontend calls most (`review`, `events`, `config`). Then generate frontend types from the spec.
- **Effort:** L
- **Grade lift:** B− → B

#### B3 — Log the silent `except Exception: pass` sites `[upstream]`
- **Where:** 26 sites, e.g. `frigate/api/auth.py:139-140`, `:1111-1112`; bare `except:` at `frigate/util/image.py:889,900,910`
- **What's wrong:** Failures degrade without a trace. The auth one at `:139` fails closed, which is correct, but you would never know it was firing.
- **Fix:** `logger.debug(..., exc_info=True)` at minimum; narrow the exception type where obvious.
- **Effort:** S
- **Grade lift:** B− → B− (reliability, not structure)

#### B4 — Declare indexes on models, not only in migrations `[upstream]`
- **Where:** `migrations/011_update_indexes.py:31-35`, `migrations/020_update_index_recordings.py:32-37`, `migrations/022`, `027` vs `frigate/models.py`
- **What's wrong:** The real schema has good covering indexes that the ORM models do not know about, so the models under-document the schema and a future `create_tables` would omit them.
- **Fix:** Add matching `class Meta: indexes = (...)` declarations; keep migrations as the source of truth for existing DBs.
- **Effort:** S
- **Grade lift:** B− → B− (hygiene)

---

## C — Frontend Quality — C

Strong foundations: every route is lazy (`web/src/App.tsx:19-32`), role gating is centralised (`components/auth/ProtectedRoute.tsx`), i18n is exhaustive and CI-enforced (3,444 `t()` calls, `i18next.config.ts`), styling is Tailwind-disciplined (64 inline styles, 5 scoped `!important`), and the WebSocket store uses `useSyncExternalStore` with per-topic bail-out (`api/ws.ts:243-262`). Undermined by 36 files over 800 lines that fuse fetching, business logic and layout (`pages/Settings.tsx` 2366 lines, 9 raw axios calls; `views/motion-search/MotionSearchView.tsx` 29 `useState`), four-level prop drilling with renames, 124 suppressed `exhaustive-deps`, no error boundary anywhere, and 77 clickable `div`/`span` elements with no role, tabIndex, or key handler.

#### C1 — Add error boundaries around routes and app chrome `[fork]`
- **Where:** `web/src/App.tsx:87-113` (route `<Suspense>`), `:126-128` (safe mode), `:73-74` (`<Sidebar/>`, `<Statusbar/>`)
- **What's wrong:** Zero `ErrorBoundary`/`errorElement` in the codebase. A render throw in any lazy page, or a chunk-load failure after a deploy, unmounts the whole app to a blank screen with no recovery. For a security appliance this is an availability bug.
- **Fix:** Add a translated `RouteErrorBoundary` inside `<Suspense>` offering reload and "report" details; a second boundary around Sidebar/Statusbar so chrome failures do not take down content. Handle `ChunkLoadError` by prompting a reload.
- **Effort:** S
- **Grade lift:** C → C+ (removes the worst user-facing failure mode)

#### C2 — Make the 77 clickable non-buttons keyboard-reachable and add `jsx-a11y` lint `[fork, upstreamable]`
- **Where:** `web/src/components/card/ReviewCard.tsx:144-146` (primary review card is a `div onClick`), `views/classification/ModelSelectionView.tsx:325-330`, 7 sites in `LiveContextMenu.tsx`, 5 in `DetailStream.tsx`, 3 in `DraggableGridLayout.tsx`; ~15 `<img>` with no `alt` (e.g. `ModelSelectionView.tsx:333-339`); `hooks/use-keyboard-listener.tsx:25-27` only exempts `INPUT`, so shortcuts fire inside textareas
- **What's wrong:** Only 8 `role="button"`, 19 `tabIndex`, 13 key handlers in 125k lines. Most interactive surfaces are mouse-only. No `eslint-plugin-jsx-a11y` means it will keep regressing.
- **Fix:** Add `plugin:jsx-a11y/recommended` to `.eslintrc.cjs`; convert card click targets to `<button>` or add `role/tabIndex/onKeyDown`; add `alt`; extend the keyboard-listener exemption to `TEXTAREA`, `SELECT`, `contenteditable`.
- **Effort:** M
- **Grade lift:** C → B− (largest UX-quality gap for a "polish" fork)

#### C3 — Extract the Settings "Save All" transaction into a tested module `[fork]`
- **Where:** `web/src/pages/Settings.tsx:930-1160` (per-section payloads, atomic detector/model PUT, go2rtc stream diff + delete, restart-flag accumulation, `Promise.allSettled`, `mutate("config")`), `console.error` swallows at `:1007,1061,1109`
- **What's wrong:** The riskiest logic in the UI lives inline in a 2366-line page with no tests and only success/fail counters shown to the user. Any settings UX polish has to work around it.
- **Fix:** Move to `web/src/lib/settings/saveAllSections.ts` taking `(pendingBySection, config, schema)` and returning a typed result; unit-test it; then shrink `Settings.tsx` by moving the 60+ `createSectionPage` constants (`:221-306`) and routing tables (`:483-570`) into `lib/settings/sections.ts`.
- **Effort:** L
- **Grade lift:** C → C+ (also unblocks D1 and any settings redesign)

#### C4 — Kill four-level prop drilling in Events → EventView → DetectionReview → MotionReview `[fork]`
- **Where:** `web/src/pages/Events.tsx:575,727,735` → `views/events/EventView.tsx:106-127` (21 props, 8 setters) → `:503-563` → `:875-877` (`markItemAsReviewed` renamed to `setReviewed`) → `:1581,1641`
- **What's wrong:** Props pass through four levels with renames that break greppability. Every review-page tweak edits three components.
- **Fix:** A `ReviewPageContext` (or a small zustand store, one file) holding filters, previews, and the reviewed-setter; leaf components read it directly. Do the same for `SearchDetailDialog.tsx` (46 props across 6 in-file components).
- **Effort:** M
- **Grade lift:** C → C+

#### C5 — Surface read-path API errors `[fork]`
- **Where:** `web/src/api/index.tsx:22-42` (global `onError` handles only 401/302/307); 372 `useSWR` calls in 138 files, one destructures `error`
- **What's wrong:** A 500 on `review/summary` or `stats` renders nothing and says nothing. Mutations toast (257 `toast.error`), reads are silent.
- **Fix:** In `SWRConfig.onError`, toast non-auth failures once per key with a cooldown; add an `ErrorState` component and use it in the top five views.
- **Effort:** S
- **Grade lift:** C → C+

#### C6 — Break up the three worst god components `[fork]`
- **Where:** `web/src/views/live/LiveCameraView.tsx` (1827), `views/motion-search/MotionSearchView.tsx` (1643, 29 `useState`, 12 `useEffect`), `components/overlay/detail/SearchDetailDialog.tsx` (1905, 6 components in one file)
- **What's wrong:** Data fetching, business rules and layout in one function. UI polish on any of these means editing a file upstream is also editing, so conflicts are guaranteed.
- **Fix:** Per file: move data + effects into a `useXxxController()` hook, move sub-components into a folder, keep the view as layout only. Do `SearchDetailDialog` first (the six components are already separable).
- **Effort:** L
- **Grade lift:** C → B−

#### C7 — Reduce the 124 `exhaustive-deps` suppressions `[fork]`
- **Where:** e.g. `web/src/pages/Events.tsx:427,453,673`, `views/search/SearchView.tsx:478`; 173 `eslint-disable` total, 124 for `react-hooks/exhaustive-deps`
- **What's wrong:** Each one is a deliberately stale closure whose correctness depends on a comment. They hide real bugs and block React Compiler adoption.
- **Fix:** Replace with `useEvent`-style stable callbacks or by deriving state; track the count in CI and ratchet down.
- **Effort:** M
- **Grade lift:** C → C+

#### C8 — Remove the dev sandbox from the production route table and fix hygiene nits `[fork]`
- **Where:** `web/src/pages/UIPlayground.tsx` (480 lines, routed at `App.tsx:107`), `utils/zoneEdutUtil.ts` (typo'd filename imported by `PolygonItem.tsx:30`, `ZoneEditPane.tsx:21`), `context/theme-provider.tsx:130` (commented console.log), `tailwind.config.cjs:7-12` (dead Next.js-style content globs), `package.json:2` (`"name": "web-new"`)
- **What's wrong:** Ships a playground to every user; small hygiene issues that a fork will trip over.
- **Fix:** Gate `UIPlayground` behind `import.meta.env.DEV`; rename the util; delete the dead globs and log; rename the package.
- **Effort:** S
- **Grade lift:** C → C (hygiene)

---

## D — Testing & Reliability — C+

Backend: 76 test files, 958 test functions, strong config/auth/authz/path-traversal coverage, CI-gated inside the devcontainer. Frontend: zero unit tests, `vite.config.ts:71` points at a `web/__test__/` directory that does not exist so `npm test` crashes on start, and the CI step has been commented out since commit bdebb99b5 (2023-12-16). The 23-spec Playwright suite (~193 tests) is genuinely excellent in craft (native WebSocket routing, an error collector that fails tests on unexpected console errors, a custom spec linter banning `waitForTimeout`) but has holes exactly where the fork will work.

#### D1 — Restore frontend unit testing `[FE] [fork, upstreamable]`
- **Where:** `web/vite.config.ts:63-79` (missing `setupFiles` target, stub coverage), `.github/workflows/pull_request.yml:49-51` (commented step), unused devDeps `msw`, `jest-websocket-mock`, `fake-indexeddb`, `@testing-library/jest-dom`, `jsdom`, `@vitest/coverage-v8`
- **What's wrong:** ~3,900 lines of pure logic (`utils/configUtil.ts` 885, `utils/cameraClone.ts` 856, `lib/config-schema/transformer.ts` 792, `utils/dateUtil.ts` 535, `api/ws.ts` parsing) have no tests, and the harness cannot even start.
- **Fix:** Create `web/__test__/test-setup.ts`; set `coverage.provider: "v8"`, `reporter: ["lcov","text-summary"]`, a low starting threshold; write tests for the five pure modules; uncomment the CI step.
- **Effort:** M
- **Grade lift:** C+ → B− (the fork's safety net for refactors in C3/C4/C6)

#### D2 — Cover Settings, MotionSearch, zone editing and the camera wizard in e2e `[FE] [fork]`
- **Where:** `web/e2e/specs/settings/ui-settings.spec.ts` (3 smoke tests for a 2366-line page), no spec for `MotionSearchView.tsx`, `MasksAndZonesView`/`ZoneEditPane`/`PolygonCanvas` (~2,600 lines), `settings/wizard/` (~2,850 lines), `DraggableGridLayout`
- **What's wrong:** The suite is deep on Live/Review/Explore/Export and nearly absent on the pages a UX fork will redesign first.
- **Fix:** One spec each, following `e2e/fixtures/frigate-test.ts` patterns; assert the `config/set` payload for a multi-section dirty state in Settings.
- **Effort:** M
- **Grade lift:** C+ → B−

#### D3 — Add a viewport between phone and desktop to the e2e matrix `[FE] [fork]`
- **Where:** `web/e2e/playwright.config.ts:8-11` (1920×1080 and 390×844 only, plus UA spoofing)
- **What's wrong:** Nothing tests the 700–1100 px range, which is exactly where the UA-based layout (A1) breaks.
- **Fix:** Add a tablet project at 1024×768 with a desktop UA; fix what fails.
- **Effort:** S
- **Grade lift:** C+ → C+ (prerequisite for A1)

#### D4 — Test the core tracking pipeline `[BE] [upstream]`
- **Where:** `frigate/track/object_processing.py` (828 lines, zero direct test references), `frigate/comms/dispatcher.py` (1219 lines, indirect only)
- **What's wrong:** The detection-to-event pipeline is the heart of the product and untested at unit level.
- **Fix:** Fixture-driven tests feeding synthetic detections through `TrackedObjectProcessor` and asserting emitted events/zones.
- **Effort:** M
- **Grade lift:** C+ → B−

#### D5 — Add coverage measurement to CI `[both] [upstream]`
- **Where:** `.github/workflows/pull_request.yml:107-131` (`python_tests` has no coverage), `web/vite.config.ts:73-75`
- **What's wrong:** No number, so no ratchet. Regressions are invisible.
- **Fix:** `coverage run -m unittest` + upload; vitest lcov; report in PR summary. No hard gate initially.
- **Effort:** S
- **Grade lift:** C+ → C+ (enables everything else)

---

## E — Security — B+

Genuinely hardened. PBKDF2-HMAC-SHA256 at 600k iterations with constant-time compare (`frigate/api/auth.py:371-390`), JWT secret created `0o600` (`:314-368`), trusted-proxy-aware login rate limiting (`:256-303,848`), Origin/CSRF middleware (`fastapi_app.py:49-56`), default-deny admin dependency (`:81-84`), zero `shell=True` across 44 subprocess sites, no SQL string interpolation of user data, thorough credential redaction in `/api/config` (`api/app.py:300-368`), a real path-traversal utility with tests (`frigate/util/path.py`). Held back by string-matched auth exemptions and no browser security headers.

#### E1 — Add security headers and fix HSTS inheritance `[upstream]`
- **Where:** `docker/main/rootfs/usr/local/nginx/templates/listen.gotmpl:25` (HSTS at server level), `nginx.conf:120,136,159,251,317,323-340` (location-level `add_header Cache-Control` which, per nginx semantics, drops the inherited HSTS)
- **What's wrong:** No `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy` anywhere, and HSTS silently disappears on ~10 locations.
- **Fix:** A `security_headers.conf` included in every location that calls `add_header`; start CSP in report-only mode because the UI uses inline workers (monaco) and blob URLs (players).
- **Effort:** S
- **Grade lift:** B+ → A−

#### E2 — Replace path-string auth exemptions with per-route markers `[upstream]`
- **Where:** `frigate/api/auth.py:64-141` (`EXEMPT_PATHS`, `EXEMPT_PREFIXES` incl. bare `"/review"` at `:110`, silent `except Exception: pass` at `:139-140`); 15 routes with no route-level dependencies (`frigate/api/classification.py:60,140,328,512,605,671,796,822`, `frigate/api/media.py:782,874,1107,1220,1252,1279,1664`)
- **What's wrong:** Correct today (verified the media routes self-enforce `require_camera_access`), but correctness depends on two hand-maintained lists. A new `/review_*` route silently loses the admin gate.
- **Fix:** Startup assertion walking `app.routes` that every route carries exactly one of `allow_public` / `allow_any_authenticated` / `require_role` / `require_camera_access`; test that enumerates all routes.
- **Effort:** M
- **Grade lift:** B+ → A−

#### E3 — Use the project's own path helper in `preview_thumbnail` `[upstream]`
- **Where:** `frigate/api/media.py:1700-1726` (user-supplied `file_name` joined under `CACHE_DIR/preview_frames` after only pathvalidate `sanitize_filename`); `media.py` never imports `frigate/util/path.py`
- **What's wrong:** Not exploitable now (separators stripped) but it is the one place relying on a weaker primitive than the codebase's own `safe_join`.
- **Fix:** `safe_join(CACHE_DIR, "preview_frames", file_name)`.
- **Effort:** S
- **Grade lift:** B+ → B+ (consistency)

---

## F — Dependencies & Tech Currency — C+

Modern where it counts (React 19, TS 5.9, lockfile v3 with deliberate `overrides`, six Dependabot ecosystems), but ESLint 8 is EOL, apexcharts is two majors behind, Tailwind 3 / react-router 6 / i18next 24 / date-fns 3 are each a major behind, `numpy == 1.26.*` pins the Python scientific stack to 1.x, `mypy == 1.6.1` from 2023 ships in the production image, both `opencv-python-headless` and `opencv-contrib-python` are installed, `py3nvml` is an unpinned git dependency, and go2rtc plus three ffmpeg builds are fetched by raw URL from personal forks with no checksum and no Dependabot visibility.

#### F1 — Migrate to ESLint 9 flat config and typescript-eslint 8 `[fork, upstreamable]`
- **Where:** `web/package.json` devDeps (`eslint ^8.57.0`, `@typescript-eslint ^7.5.0`), `web/.eslintrc.cjs` (duplicate `ignorePatterns` at `:11` and `:25`; TS override re-extends `"prettier"` at `:70`, disabling root `comma-dangle`; `settings.jest.version: 27` in a vitest project at `:21-23`; `prettier/prettier` at `"warn"` `:56`)
- **What's wrong:** EOL linter, a parser version that predates TS 5.9, and three silent config bugs.
- **Fix:** `eslint.config.js` with `typescript-eslint` v8; merge ignore lists; drop the prettier re-extend and jest block; set `prettier/prettier` to error; add `jsx-a11y` while there (C2).
- **Effort:** M
- **Grade lift:** C+ → B−

#### F2 — Pin and verify the binary downloads `[upstream]`
- **Where:** `docker/main/Dockerfile:63-66` (go2rtc v1.9.14 via `ADD --link`, no checksum), `docker/main/install_deps.sh:48-77` (three ffmpeg tarballs from `NickM-27/FFmpeg-Builds`, no SHA256), `docker/main/requirements-wheels.txt:27` (`git+https://github.com/fbcotter/py3nvml` with no ref), `.github/workflows/stale.yml:14` (`actions/stale@main`)
- **What's wrong:** Non-reproducible, unsigned supply chain for the two most security-relevant binaries; Dependabot cannot see any of it.
- **Fix:** `ADD --checksum=sha256:...`; SHA256 verify in `install_deps.sh`; pin `py3nvml` to a commit; pin `actions/stale` to a tag; a `make check-binary-versions` target.
- **Effort:** S
- **Grade lift:** C+ → B−

#### F3 — Clean the Python wheel set `[upstream]`
- **Where:** `docker/main/requirements-wheels.txt:19` (mypy 1.6.1 at runtime), `:41-42` (both opencv packages), `:45` vs `requirements-ov.txt:2` (openvino 2025.4 runtime vs >=2026.2 converter), `:40` (numpy 1.26)
- **What's wrong:** Dev tooling in the prod image, a documented `cv2` conflict, and an undocumented OpenVINO version split between model conversion and inference.
- **Fix:** Move mypy to `requirements-dev.txt` and unpin; keep only `opencv-contrib-python-headless`; align or document the OpenVINO pins; plan the numpy 2 migration behind the onnxruntime/openvino wheels that support it.
- **Effort:** M
- **Grade lift:** C+ → B−

#### F4 — Queue the frontend major bumps as separate PRs `[fork]`
- **Where:** `web/package.json`: `apexcharts ^3.52.0` + `react-apexcharts ^1.4.1`, `tailwindcss ^3.4.9` (blocked by `tailwind-scrollbar ^3`), `react-router-dom ^6.30.3`, `i18next ^24.2.0`, `date-fns ^3.6.0`, `vite ^6.4.2`, `jsdom ^24`
- **What's wrong:** Each is one or two majors behind; Tailwind 4 in particular changes the theming model the fork will lean on.
- **Fix:** One PR per major, e2e green between each. Tailwind last, after replacing `tailwind-scrollbar`.
- **Effort:** L
- **Grade lift:** C+ → B

#### F5 — Retire abandoned packages and document the Radix patches `[fork, upstreamable]`
- **Where:** `web/package.json`: `sort-by`, `strftime`, `nosleep.js`, `vite-plugin-monaco-editor` (note the `.default()` interop hack at `vite.config.ts:53`), `patch-package`; `web/patches/*.patch` (two React 19 fixes for Radix `compose-refs` and `slot` with no explanatory comment or removal criterion); repo-root `package-lock.json` (empty stub, no `package.json`)
- **What's wrong:** Dormant deps and two silent upgrade landmines.
- **Fix:** Replace `sort-by` with a comparator, `strftime` with date-fns, `nosleep.js` with `navigator.wakeLock`; add `patches/README.md` linking the upstream Radix issues and the version at which each can be dropped; delete the stub lockfile.
- **Effort:** S
- **Grade lift:** C+ → B−

---

## G — Performance & Scalability — C+

Pipeline side is thoughtful: shared-memory frames, covering SQLite indexes tuned for the summary API (`migrations/020:35`), a `useSyncExternalStore` WebSocket layer, virtualised timelines, predicate-based SWR polling. The API layer negates it: ~48 `async def` handlers run synchronous peewee queries on the event loop, `/events/search` fetches every matching row before slicing, and the frontend's main chunk carries the full Lucide icon set plus framer-motion and zod through the eager Sidebar.

#### G1 — Get the whole icon library and heavy deps out of the eager main chunk `[fork, upstreamable]`
- **Where:** `web/src/utils/iconUtil.tsx:47` (`import * as LuIcons from "react-icons/lu"`), `components/icons/IconPicker.tsx:3,39` (`Object.entries(LuIcons)`), reached via `App.tsx:73` → `Sidebar.tsx:3` → `CameraGroupSelector.tsx:74` (1,224 lines; also pulls `framer-motion :19`, `zod`/`react-hook-form :63-65`, `CameraStreamingDialog :84`); `GeneralSettings` (813 lines) and `AccountSettings` eager via `Sidebar.tsx:5-6`
- **What's wrong:** ~1,500 icons and three heavy libraries ship before first paint on every load because of one namespace import that defeats tree-shaking.
- **Fix:** Lazy-load `IconPicker` and `CameraGroupSelector`; resolve icons from a small explicit map in `iconUtil.tsx`; lazy-load the two settings dialogs from the sidebar.
- **Effort:** M
- **Grade lift:** C+ → B (largest first-paint win available)

#### G2 — Set a global SWR policy and stop mutating axios in render `[fork, upstreamable]`
- **Where:** `web/src/api/index.tsx:16-19` (`axios.defaults.headers.common = {...}` in the render body), `:22-42` (`SWRConfig` with only `fetcher`/`onError`)
- **What's wrong:** With SWR defaults and 372 hooks, every tab refocus fires a revalidation storm. The axios mutation is an impure render side effect that clobbers rather than merges.
- **Fix:** Move the axios setup to module scope; add `dedupingInterval`, `focusThrottleInterval`, `errorRetryCount`, `keepPreviousData`.
- **Effort:** S
- **Grade lift:** C+ → B−

#### G3 — Stop blocking the event loop in async handlers `[upstream]`
- **Where:** `frigate/api/media.py:794,890`, `review.py:51`, `record.py:123,227,363`, `event.py:478,1003,1661`, `export.py:916,1066` (~48 sites); contrast `media.py:1446` which correctly uses `asyncio.to_thread`
- **What's wrong:** `SqliteQueueDatabase` serialises writes; one slow query inside an `async def` stalls every concurrent request including the nginx `/auth` subrequest that gates all media.
- **Fix:** Convert to plain `def` (FastAPI offloads to the threadpool) or wrap in `asyncio.to_thread`; enable ruff's full `ASYNC` ruleset.
- **Effort:** M
- **Grade lift:** C+ → B

#### G4 — Push `LIMIT` into `/events/search` and fix the JSON join `[upstream]`
- **Where:** `frigate/api/event.py:811-884` (no SQL LIMIT, Python sort, slice at `:884`; LEFT JOIN on `fn.json_extract(ReviewSegment.data,"$.detections").contains(Event.id)` at `:811-815`)
- **What's wrong:** Materialises every matching event and full-scans `reviewsegment` per row.
- **Fix:** SQL `ORDER BY`/`LIMIT` for non-relevance sorts; bound the candidate set from the vector search first; replace the JSON contains join with a join table or generated column; add cursor pagination.
- **Effort:** M
- **Grade lift:** C+ → B−

#### G5 — Lazy-load players and add explicit vendor chunks; virtualise card grids `[fork]`
- **Where:** `web/vite.config.ts:43-50` (no `manualChunks`), `components/player/LivePlayer.tsx:8` and `BirdseyeLivePlayer.tsx:4` (static `JSMpegPlayer` import even when mode is webrtc/mse), `package.json:102,131` (`vite-plugin-monaco-editor` in deps, `monaco-editor` in devDeps), `views/search/SearchView.tsx:484-508`, `RecordingView.tsx:541`, `EventView.tsx:673` (infinite scroll with every card kept mounted); one `React.memo` in the whole app (`components/ws/WsMessageRow.tsx:299`) vs 953 `useMemo`
- **What's wrong:** Chunking is accidental; the Live index route ships jsmpeg to everyone; long Explore sessions grow the DOM without bound; memoisation is applied to values but not render boundaries.
- **Fix:** `React.lazy` the three players and select at render time; `manualChunks` for react/radix/apexcharts/monaco; fix the monaco dep inversion; `rollup-plugin-visualizer` in CI; virtualise the three card grids; `React.memo` the card components.
- **Effort:** M
- **Grade lift:** C+ → B−

---

## H — Documentation & Onboarding — C

The generated, CI-verified OpenAPI spec (`generate_api_auth_spec.py --check` at `pull_request.yml:129`) is exemplary and `AGENTS.md` (450 lines, `CLAUDE.md` symlinked to it) is a real guide. But `README.md` has no contributing link at all, `CONTRIBUTING.md:81-95` omits four of the six PR gates (devcontainer, mypy, API spec check, i18n extract, Playwright), there are no architecture docs or ADRs for a system whose complexity is its process topology, docstring coverage is roughly 26% against a stated "required" policy, and six statements are stale or wrong.

#### H1 — Fix the stale and wrong statements `[upstream]`
- **Where:** `AGENTS.md:11,28` ("Python 3.13+"; runtime is 3.11 per `docker/main/Dockerfile:167`), `docs/docs/development/contributing.md:195` ("Preact", removed 2023), `:187-191` (tells you to hand-edit `vite.config.ts` instead of `PROXY_HOST`), `:207-212` (points at a test suite that does not exist), `:88` (`docker-compose` v1 syntax), `docs/docs/integrations/api.md` (0-byte file colliding with the generated `api/` directory route)
- **What's wrong:** The AI-agent guide and the official contributing page both send new contributors down wrong paths.
- **Fix:** Correct each line; delete the empty `api.md`.
- **Effort:** S
- **Grade lift:** C → C+

#### H2 — Make CONTRIBUTING match CI `[upstream]`
- **Where:** `CONTRIBUTING.md:81-95`, `README.md` (no Contributing section)
- **What's wrong:** Following the file exactly still fails CI.
- **Fix:** A "What CI checks" block listing all six gates verbatim; a "Development environment" section pointing at `.devcontainer/`; a Contributing link in the README.
- **Effort:** S
- **Grade lift:** C → B−

#### H3 — Write the frontend README the codebase deserves `[fork]`
- **Where:** `web/README.md` (25 lines for 125k lines of code); `web/e2e/` has no README (mocking architecture only discoverable from `e2e/fixtures/frigate-test.ts:1-16` docstrings)
- **What's wrong:** Directory rules (`pages/` vs `views/` vs `components/`), the `--base=/BASE_PATH/` sentinel, why `patches/` exists, how e2e mocking works, and the i18n workflow are all undocumented. For a fork that will be mostly UI, this is the onboarding doc.
- **Fix:** Sections for layout conventions, dev loop against a live box, tests, i18n, patches, build/deploy. Add `web/e2e/README.md`.
- **Effort:** S
- **Grade lift:** C → B−

#### H4 — Add an architecture page `[upstream]`
- **Where:** `docs/docs/development/` (two "how to build" files only); `@docusaurus/theme-mermaid` already installed and unused
- **What's wrong:** No description of process topology, shared-memory frame lifecycle, ZMQ topics, or the detector plugin interface.
- **Fix:** One page with a mermaid diagram of processes and IPC, plus a table of ZMQ topics; link from CONTRIBUTING.
- **Effort:** M
- **Grade lift:** C → B−

---

## I — Developer Experience & Tooling — C+

The devcontainer is excellent: it builds the production Dockerfile's `devcontainer` target, labels six ports, seeds a config, and CI runs the Python tests inside it. TypeScript is `strict` and `tsc` gates the build; the i18n extractor and a custom e2e spec linter are CI-gated. Against that: `npm test` has been physically broken for ~2.7 years, there is no pre-commit hook anywhere, CI has zero caching and builds a full Docker image per PR (~20–35 min feedback), mypy is disabled for most of the backend, ruff permits exactly the logging style `AGENTS.md` forbids, and `Makefile` has no inner-loop targets.

#### I1 — Add pre-commit and CI caching `[fork, upstreamable]`
- **Where:** repo root (no `.pre-commit-config.yaml`), `.github/workflows/pull_request.yml:19-25,38-44,57-63,115-119` (four `setup-node` steps with no `cache`, `npm install` not `npm ci`), `:93` (no pip cache)
- **What's wrong:** Every lint slip costs a full CI round-trip; CI does cold installs of ~1,400 packages four times per PR.
- **Fix:** `.pre-commit-config.yaml` with ruff, ruff-format, prettier, eslint; `cache: npm` + `cache-dependency-path: web/package-lock.json`; `npm ci`; `cache: pip`. Document `pre-commit install` in `.devcontainer/post_create.sh`.
- **Effort:** S
- **Grade lift:** C+ → B

#### I2 — Add inner-loop Makefile targets and a fast test path `[fork]`
- **Where:** `Makefile` (build-only targets; `run_tests` at `:55-59` does a full `make local` Docker build first; `VERSION` hardcoded at `:4`)
- **What's wrong:** The everyday commands live in prose across three markdown files, and the only test target takes minutes before it starts.
- **Fix:** `make lint`, `make format`, `make test-py` (no image build), `make test-web`, `make e2e`, `make dev-web PROXY_HOST=...`.
- **Effort:** S
- **Grade lift:** C+ → B−

#### I3 — Ratchet mypy back on `[upstream]`
- **Where:** `frigate/mypy.ini:31-70` (`ignore_errors = true` for `frigate.api.*`, `config.*`, `util.*`, `video.*`, `detectors.*`, `embeddings.*`, `ptz.*`, `stats.*`, `test.*`; "TODO: Remove ignores" at `:31`)
- **What's wrong:** Strict flags apply to a minority of the code; all 181 routes are unchecked.
- **Fix:** Remove ignores smallest-module-first (`stats`, then `util`), each as its own PR so the ratchet is permanent.
- **Effort:** L
- **Grade lift:** C+ → B−

#### I4 — Make the linter agree with the style guide `[upstream]`
- **Where:** `pyproject.toml:4-6` (`G004` ignored, `E501` ignored, no `S` rules, no `[tool.ruff.format]`); `AGENTS.md` ("use lazy logging", "under 88 characters"); `.pylintrc` at root (pylint is not used anywhere); `.devcontainer/devcontainer.json:76,92-94` (removed `python.formatting.provider`, unused isort args); `cspell.json` configured but not in CI
- **What's wrong:** The tool permits what the doc forbids; dead config files mislead.
- **Fix:** Drop the `G004` ignore and fix the f-string logs, add `line-length = 88` or delete the doc claim, add `S` (bandit) rules, delete `.pylintrc`, clean the devcontainer settings, run cspell in `python_checks`.
- **Effort:** S
- **Grade lift:** C+ → B−

#### I5 — Type-check `e2e/` and add a typed `.env.example` for the frontend `[fork]`
- **Where:** `web/tsconfig.json:27` (`"include": ["src"]`, so ~5,900 lines of e2e TypeScript are never type-checked by `npm run build`), no `web/.env.example` for `PROXY_HOST`
- **What's wrong:** e2e type errors surface only when Playwright transpiles; the one env var that matters is undocumented at the point of use.
- **Fix:** A `tsconfig.e2e.json` referenced from `npm run lint`; `web/.env.example` with `PROXY_HOST=<frigate-host>:5000`.
- **Effort:** S
- **Grade lift:** C+ → C+ (hygiene)
