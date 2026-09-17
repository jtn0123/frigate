# Codebase Grade Report

**Project:** frigate, fork `jtn0123/frigate`, branch `next` @ edfdfcfa5 (base upstream v0.18.0; `main` is promoted from `next`)
**Audited:** 2026-09-17 (second regrade; earlier: baseline of upstream `dev` and first regrade, both 2026-09-10 @ 752bc3047)
**Stack:** Python 3.11 / FastAPI 0.116 / peewee 3.17 + SQLite (WAL) / pydantic 2.10 / ZMQ multiprocess pipeline, go2rtc + ffmpeg binaries; React 19 / TypeScript 5.9 (strict) / Vite 6 / Tailwind 3 / Radix + shadcn / SWR / react-router 7 / i18next 24; vitest + Playwright; SonarCloud, CodeQL, gitleaks; Debian 12 Docker image (plus ROCm), nginx front
**Focus:** frontend (`web/`). This fork exists for UI/UX work, with a growing stability track in the backend.

**How IDs work in this file.** IDs are stable across regrades because commits,
`FORK.md` and `fork/PLAN.md` refer to them. Done items are struck through
with ✓ and kept as one line. New items take the next free number in their
category. `FORK.md` is the ledger of everything that shipped. IDs that were
created directly in the ledger as bug fixes or features (C13 to C19, D17 to
D47, E7 to E14, I15 to I26, SV1 to SV10, UI43 to UI99) are defined there and
are not repeated here. This file defines the audit items and says which are
still open.

**What changed since 2026-09-10.** 422 commits, about 78k lines added. Test
volume roughly tripled (71 vitest files, 54 e2e specs, 1,343 backend tests),
the client/server contract is typed from the OpenAPI spec (A5), the security
scans were triaged (E4, E5), and SonarCloud gates new code at 80% coverage.
The structural debt did not move: the same god files, the same 107
`exhaustive-deps` suppressions, no service layer, no HTTP caching. Feature work is outrunning the cleanup track.

## Summary

| ID | Category | Baseline | 09-10 | Now | Open items |
|----|----------|----------|-------|-----|------------|
| A | Architecture & Design | B− | B− | B | 5 |
| B | Backend Quality | B− | B | B | 7 |
| C | Frontend Quality | C | C+ | B− | 14 |
| D | Testing & Reliability | C+ | B− | B | 7 |
| E | Security | B+ | B+ | B+ | 6 |
| F | Dependencies & Tech Currency | C+ | B− | B− | 5 |
| G | Performance & Scalability | C+ | B− | C+ | 10 |
| H | Documentation & Onboarding | C | C+ | C+ | 5 |
| I | Developer Experience & Tooling | C+ | B | B | 9 |
| **Overall** | | **B−** | **B** | **B** | **68** + UX track |

**Top 5 highest-leverage open fixes:** I27 (owner: add the secret), E15, E16, B5, I29

**Type safety at a glance.** Frontend: TypeScript `strict` gates the build and
`fork/type-ratchet.json` holds every escape hatch (`explicitAny` 23,
`tsExpectError` 14, `asUnknownAs` 25, floating and misused promises 0,
`no-unnecessary-condition` 1,482). API reads for config, review, events and
stats use types generated from the spec (`web/src/types/fork/api.gen.ts`,
11,234 lines). Backend: mypy still has `ignore_errors = true` for `api`,
`config`, `detectors`, `embeddings`, `ptz`, `util`, `video`, tests and
`whisper_online` (`frigate/mypy.ini:28-55`), so the fork's own new code in
`frigate/video/` and `frigate/api/` is unchecked; 125 `type: ignore` and 734
`Any` outside tests; 77 of 189 routes declare a `response_model`.

---

## A — Architecture & Design — B

Holds at B (lifted from B− by A5). The process model (ZMQ IPC
`frigate/comms/zmq_proxy.py`, shared-memory frames, a fail-closed WebSocket
classifier at `frigate/comms/ws.py:310`) is still the strongest part, and the
fork follows its own rule of adding files instead of editing them: 29 new
backend modules and 109 fork frontend files against 5 upstream backend files
with more than 100 changed lines. Held at B because nothing structural moved:
no service layer while the routers grew (`frigate/api/event.py` 2,394 lines,
`media.py` 1,917), 39 frontend files over 800 lines
(`web/src/pages/Settings.tsx` 2,360), UA sniffing went up (264 `isMobile`,
401 `isDesktop`), and `frigate/video/ffmpeg.py` (243 changed lines) and
`frigate/api/camera.py` (279) have become co-owned files.

- ~~A4~~ ✓ done 2026-09-11. `App` fetches config once
- ~~A5~~ ✓ done 2026-09-11. Generated `api.gen.ts`, `useApi`/`apiGet` for config/review/events/stats

#### A6 — Split `CameraWatchdog.run` before it grows again `[fork]`
- **Where:** `frigate/video/ffmpeg.py:350-651` (302 lines, up from about 230 upstream)
- **What's wrong:** One loop interleaves config updates, the hwaccel reset, enable and record transitions, the segment drain, backoff, detect liveness and stall checks, record staleness (SV3) and the outage tick (SV6). It is the largest fork-touched function and the worst rebase-conflict surface in the backend.
- **Fix:** Extract `_drain_segment_updates()`, `_check_detect_process(now, can_restart)` and `_check_record_processes(now)`; `run` drops to about 90 lines. Behavior unchanged; the existing watchdog tests cover it.
- **Effort:** M
- **Grade lift:** B → B (smaller rebase hunks; makes B5 easy to test)

#### A1 — Introduce a viewport hook and retire user-agent layout branching `[fork]` (= UI5)
- **Where:** `web/src/App.tsx`, `components/navigation/{Sidebar,Bottombar,NavItem}.tsx`, `hooks/use-navigation.ts`; 665 `isMobile`/`isDesktop` references (up from 594). No `use-viewport` hook exists; the `viewportLayout` flag in `web/src/fork/flags.ts` has no production consumer.
- **What's wrong:** Layout is picked from UA constants evaluated once; narrow desktop windows and rotated tablets get the wrong tree.
- **Fix:** `web/src/hooks/fork/use-viewport.ts` (`matchMedia` + `useSyncExternalStore`) for the shell and navigation only, flag `viewportLayout`; ships with D3. Not a full migration.
- **Effort:** M (scoped)
- **Grade lift:** B → B (removes the worst layout bug)

#### A7 — Delete dead feature flags and retire single-consumer ones `[fork]`
- **Where:** `web/src/fork/flags.ts` (16 flags, all default `true`): `liveLayoutMemory` has zero consumers, `viewportLayout` is read only by `fork/flags.test.ts:61,71`; 7 of 16 flags have one consumer
- **What's wrong:** A flag that is on by default and gates nothing misleads anyone setting `localStorage.frigateFork`; the file's own docblock says to keep it tiny.
- **Fix:** Delete the two dead flags until UI5/UI13 land. For features that have shipped in two or more releases, inline the flag and remove it.
- **Effort:** S
- **Grade lift:** B → B (hygiene)

#### A2 — Split `ws.ts` into transport, state diffing and hooks `[fork]`, backlog
- **Where:** `web/src/api/ws.ts` (886 lines, unchanged)
- **What's wrong:** Protocol parsing, camera-activity diffing and about 50 hooks share one file.
- **Fix:** `web/src/api/ws/{store,protocol,hooks}.ts`, `ws.ts` re-exports.
- **Effort:** S
- **Grade lift:** B → B (testability, conflict surface)

#### A3 — Add a service layer for the largest routers `[upstream]`, backlog
- **Where:** `frigate/api/event.py` (2,394), `media.py` (1,917), `chat.py` (1,584), `app.py` (1,539), `camera.py` (1,344)
- **What's wrong:** Handlers hold business logic and query peewee directly; every router grew since the last audit.
- **Fix:** `frigate/services/<domain>.py`, one router at a time. `frigate/api/camera_config.py` (the extracted camera delete) shows the pattern.
- **Effort:** L
- **Grade lift:** B → B+

---

## B — Backend Quality — B

Holds at B. The fork-added backend code is the best in the repo: 91% of its
public functions have docstrings, zero bare `except`, four broad excepts that
all log and are justified, no exception text in responses, bounded histories
(`restart_log.py:22-23`, `camera_outage.py:26-27`), a tested migration
rollback (`migrations/036`), and every one of the 29 new modules has a test.
It is held out of B+ by defects that tests did not catch because they are
about time and scale: the hardware-decoding retry that never fires (B5), a
lock held across a 10 s HTTP call (B6), an unbounded dict (B7), plus 112 of
189 routes with no `response_model` and a logging rule no linter enforces.

- ~~B1~~ ✓ done 2026-09-10. HTTPException renders `{success, message, detail}`
- ~~B3~~ ✓ done 2026-09-10. 25 `except Exception: pass` sites log; bare `except:` narrowed

#### B5 — The remembered software-decoding fallback never expires, and an exit is classified twice `[fork]`
- **Where:** `frigate/video/hwaccel_fallback.py:127-130,143-144,211-232`; `frigate/video/ffmpeg.py:158,281,346,475`; `frigate/video/restart_log.py:138`
- **What's wrong:** (1) `expires` is read only at construction (`ffmpeg.py:158`) and `record_crash` returns early once `active`, so "hardware decoding is tried again after 7 days" is false for any process that stays up; the GPU is retried only after a restart or config change. (2) `_check_hwaccel_fallback` snapshots `logpipe.deque` at `ffmpeg.py:475`, then `note_exit` re-reads it after up to 30 s of `communicate`/`kill`, so the fallback counter and the restart log can disagree about the same crash. (3) `_save` leaks its `mkstemp` file when the write fails and never fsyncs, although `frigate/util/atomic.py:8-27` (`write_private_file`) already does both.
- **Fix:** In the watchdog tick, reset the fallback and restart detect when `time.time() >= expires`. Take one `lines = list(self.logpipe.deque)` at the top of the exit path and pass it to both classifiers. Replace `_save`'s body with `write_private_file`. Tests with the injected clock for the expiry, and a failing-write test that asserts no `.tmp` remains.
- **Effort:** S
- **Grade lift:** B → B+ (with B6 and B7: the fork's backend would have no known defects)

#### B6 — The update checker holds its lock across a 10 s network call `[fork]`
- **Where:** `frigate/fork/updates.py:125-135,149-165,179-190`; sync route `frigate/api/fork_updates.py:32`
- **What's wrong:** `state()` takes `self._lock` and calls `fetch_releases()` (`timeout=10`) while holding it. With GitHub slow, every concurrent poller parks a threadpool worker behind the same lock. The checker is also a module global, so its 6 h cache is per process.
- **Fix:** Fetch outside the lock (mark refreshing, release, fetch, re-acquire to store) and serve the stale value meanwhile; hang the checker on `app.state` as `ai_models_lock` does (`frigate/api/ai_models.py:72-73`).
- **Effort:** S
- **Grade lift:** B → B

#### B7 — `RestartLog._dumped` grows without bound `[fork]`
- **Where:** `frigate/video/restart_log.py:82`
- **What's wrong:** Keys are `(role, kind, normalized message)`; entries are overwritten but never evicted, so a flaky camera with varied ffmpeg error text leaks slowly in a process that runs for months. `record` also makes 3 to 5 manager round trips per restart (`:97-122`) on an undocumented single-writer assumption.
- **Fix:** Prune keys older than `REPEAT_WINDOW_SECONDS` inside `note_exit` (or a 64-entry LRU); trim history with one `self.history[:] = kept`; comment the single-writer invariant.
- **Effort:** S
- **Grade lift:** B → B

#### B8 — Make the logging and exception rules enforceable `[fork]`
- **Where:** `pyproject.toml:21` (ignores `G004` while selecting `G`), `:28` (stale `ASYNC230` per-file ignore for `frigate/api/camera.py`, whose blocking code moved to `camera_config.py`); f-string log calls in `frigate/video/ffmpeg.py` (19), `hwaccel_fallback.py` (3), `restart_log.py` (2), `camera_outage.py` (2), `fork_share.py` (1); silent swallow `frigate/genai/plugins/ollama.py:288-289`; one broad try around three probes `:322-333`
- **What's wrong:** `AGENTS.md` mandates lazy `%s` logging and logged, narrow excepts, but nothing enforces it and the fork's files mix both styles.
- **Fix:** Enable `G004` for fork-owned files (per-file ignores for upstream files so rebases stay clean) and convert the fork's sites; log at `ollama.py:289`; narrow the probe's try to the two network calls; drop the stale `ASYNC230` ignore.
- **Effort:** S
- **Grade lift:** B → B (hygiene)

#### B9 — Give the fork's own routes response models `[fork]`
- **Where:** `frigate/api/fork_share.py:77,130,168`, `fork_updates.py:31`, `review_audio.py:87`, `stream_diagnostics.py:162` (`ai_models.py:61,116` already use return annotations)
- **What's wrong:** The newest routes return raw dicts, so they are untyped in `docs/static/frigate-api.yaml` and in the generated client types that A5 introduced.
- **Fix:** Pydantic models in `frigate/api/defs/response/`, regenerate the spec and `api.gen.ts`, move the frontend callers to `useApi`.
- **Effort:** S
- **Grade lift:** B → B (stops B2 getting worse)

#### B2 — Declare `response_model` on the remaining 112 routes `[upstream]`, backlog
- **Where:** `frigate/api/**/*.py` (77 of 189 routes covered; `app.py` 30 routes with none, `media.py` 28, `auth.py` 12, `camera.py` 12)
- **What's wrong:** More than half the API is untyped in the OpenAPI spec, which caps what A5's generated types can cover.
- **Fix:** Add pydantic response models, frontend-heaviest routes first.
- **Effort:** L
- **Grade lift:** B → B+

#### B4 — Declare indexes on models, not only in migrations `[upstream]`, backlog
- **Where:** `migrations/011`, `017`, `020`, `022`, `027`, `036` vs `frigate/models.py` (only `UserReviewStatus` has `Meta.indexes`, `:123-124`); `ShareLink` (`:167-175`) lacks the `expires_at` index that `migrations/036:50` creates and the pruning query (`frigate/events/share_links.py:21`) filters on
- **What's wrong:** Models under-document the real schema; the fork repeated the pattern one migration after it was written up.
- **Fix:** Matching `class Meta: indexes`, starting with `ShareLink`; migrations stay authoritative.
- **Effort:** S
- **Grade lift:** B → B (hygiene)

---

## C — Frontend Quality — B−

Up from C+. New fork code is strong: module stores with
`useSyncExternalStore` instead of prop drilling, pure logic split out and
unit-tested file by file, all storage behind `lib/fork/local-storage.ts`,
every listener and observer cleaned up, `ErrorState` and `Skeleton` on new
views, deliberate a11y (`role="slider"` with `aria-valuenow` on the timeline
handle, keyboard map in `utils/timelineKeys.ts`), and no hard-coded strings in
new components. Floating promises are errors and the type ratchet holds. It
stops at B− because the app-level debt is untouched after 422 commits:
`handleSaveAll` is 296 untested inline lines (`pages/Settings.tsx:910-1205`), 39 files exceed
800 lines, 107 `exhaustive-deps` suppressions remain, and 10 defects found in
fork code by this audit are open (C20 to C29). The jsx-a11y findings were
already at zero (cleared by 8e154085e on 2026-09-12); C9 turned the rules
into errors so they stay there.

- ~~C1~~ ✓ done 2026-09-10. `components/fork/RouteErrorBoundary.tsx`, chunk-load recovery
- ~~C2~~ ✓ done 2026-09-10. jsx-a11y lint, 42 role/tabIndex sites, 27 real buttons (residue tracked as C9)
- ~~C5~~ ✓ done 2026-09-10. SWR read-error toasts + `ErrorState`
- ~~C9~~ ✓ done 2026-09-17. All 32 enabled jsx-a11y rules plus `control-has-associated-label` are errors (`web/eslint.config.js`); 0 sites needed fixing because 8e154085e had cleared the 83 findings. Six per-site suppressions remain: `media-has-caption` on the four camera `<video>` players, the paste target in `ImageEntry.tsx:137`, the click map in `LiveBirdseyeView.tsx:286`. `web/src/components/ui/**` is outside eslint
- ~~C8~~ ✓ done 2026-09-10. Sandbox gated to dev
- ~~C10~~ ✓ done 2026-09-11. TypeScript hatch ratchet, fork-strict typecheck
- ~~C11~~ ✓ done 2026-09-11. Floating and misused promises are errors (269 → 0)
- ~~C12~~ ✓ done 2026-09-11. SonarCloud findings in fork web code (3 props types still not `Readonly`: `EventSummaryHeader.tsx:37`, `updates/ReleaseNotesDialog.tsx:38,78`)
- C13 to C19: see `FORK.md`

#### C3 — Extract the Settings "Save All" transaction into a tested module `[fork]`
- **Where:** `web/src/pages/Settings.tsx:910-1205` (`handleSaveAll`, about 296 lines: per-section payloads, detector/model PUT, go2rtc diff and delete at `:809-840`, restart flags, `Promise.allSettled`, `mutate("config")`); duplicate go2rtc credential diff in `web/src/lib/fork/settings-diff.ts:110-134`
- **What's wrong:** The riskiest UI logic is inline and untested, and the review dialog computes the go2rtc diff with a second copy of the logic, so the dialog can disagree with what Save All does.
- **Fix:** `web/src/lib/fork/settings-save.ts` with vitest for ordering, partial failure and restart-required; both `Settings.tsx` and `settings-diff.ts` call one go2rtc diff function.
- **Effort:** M
- **Grade lift:** B− → B− (risk reduction on the most dangerous screen)

#### C20 — Explore re-renders every thumbnail on every render `[fork]`
- **Where:** `web/src/views/search/SearchView.tsx:318,338`; `web/src/hooks/fork/use-bulk-selection.ts:73,117,123,138-148`; `components/card/SearchThumbnail.tsx:191`
- **What's wrong:** An inline `getId` arrow is a dependency of `selectAll`, `onItemClick` and the hook's final `useMemo`, so `bulk` is a new object each render, `onThumbnailClick` changes identity, and `MemoizedSearchThumbnail` never skips. The comment next to it says the callback is stable; it is not. This undoes G5.
- **Fix:** `const getId = useCallback((i: SearchResult) => i.id, [])`; a render-count test on the hook.
- **Effort:** S
- **Grade lift:** B− → B− (restores a shipped optimization)

#### C21 — Inbox store: tabs overwrite each other, a write per message, fragile thumbnails `[fork]`
- **Where:** `web/src/lib/fork/inbox-store.ts:116-119,140,244`; `web/src/hooks/fork/use-inbox.ts`; `web/src/components/fork/InboxBell.tsx:228`
- **What's wrong:** `reloadInboxFromStorage` is exported and called only from its test, so two tabs blind-write the same key and wipe each other's read state. Every `reviews` WebSocket message JSON-stringifies up to 200 items synchronously. The thumbnail URL uses an unanchored `.replace("/media/frigate/", "")` with no `onError`.
- **Fix:** A `storage` event listener that calls `reloadInboxFromStorage`; debounce persistence (about 1 s trailing) while keeping `emit()` synchronous; anchored regex plus an `onError` fallback to `/api/review/{id}/thumbnail.webp`.
- **Effort:** S
- **Grade lift:** B− → B−

#### C22 — Non-English users get a 404 per fork namespace load, and one string skips `t()` `[fork]`
- **Where:** `web/public/locales/*/` (58 locale folders, only `en/fork.json` exists); `web/src/utils/i18n.ts:33-37`; `web/src/components/fork/bulk/BulkActionBar.tsx:96` (`"Unknown error"`)
- **What's wrong:** `i18next-http-backend` requests `locales/{lng}/fork.json`, gets a 404, then falls back to English. Every fork surface is English-only and translators have no target file.
- **Fix:** Seed `fork.json` in the other locales from the extraction script (empty values fall back) and add it to the locale sync; replace the literal with a `fork.json` key.
- **Effort:** S
- **Grade lift:** B− → B−

#### C23 — Clearing a time field sends `NaN` into range filters `[fork, upstreamable]`
- **Where:** `web/src/components/input/TimeInput.tsx:27-38`; consumers `components/overlay/CustomTimeSelector.tsx:147-152,195-200`, `views/motion-search/MotionSearchDialog.tsx:646,695`
- **What's wrong:** `input[type=time]` yields `""` when cleared or partly typed; `Number.parseInt("")` is `NaN`, `setHours(NaN)` makes an invalid date and `onChange(NaN)` reaches the `after`/`before` filter state.
- **Fix:** Return early when the value is empty or any parsed part is `NaN`; vitest for the cleared and partial cases.
- **Effort:** S
- **Grade lift:** B− → B−

#### C24 — Audio review results poll forever and ignore the app's time settings `[fork]`
- **Where:** `web/src/components/timeline/AudioReviewResults.tsx:75-78,113`
- **What's wrong:** `refreshInterval: 15000` never stops, even when the status is `unavailable` or every chunk is `failed`/`expired`. Times use `toLocaleTimeString()`, ignoring `config.ui.timezone` and `time_format` (the bug UI94 fixed for telemetry).
- **Fix:** A function `refreshInterval` that returns 0 for terminal states; format with `useMetricTimeFormatter` (`hooks/fork/use-metric-time.ts`).
- **Effort:** S
- **Grade lift:** B− → B−

#### C25 — Two `MutationObserver`s watch whole subtrees `[fork]`
- **Where:** `web/src/components/fork/settings/SettingsNav.tsx:175-176,185-210`; `web/src/hooks/fork/use-restored-scroll.ts:57-63`
- **What's wrong:** Both observe `{childList: true, subtree: true}`: SettingsNav rescans every anchor on any mutation in the 1,377-line form and calls `getBoundingClientRect()` per anchor per scroll event; scroll restore runs on every DOM mutation of a long review list for up to 10 s.
- **Fix:** Filter mutations to `[data-settings-anchor]` targets and use one `IntersectionObserver` for the scrollspy; drive scroll restore from a `ResizeObserver` on the list's height.
- **Effort:** S
- **Grade lift:** B− → B−

#### C26 — The command palette's settings list is a hand-kept copy, and the diff cache pins the schema `[fork]`
- **Where:** `web/src/lib/fork/command-items.ts:4,16` ("copied from the `settingsGroups` table"); `web/src/lib/fork/settings-diff.ts:307-328`
- **What's wrong:** Nothing tests the palette's 59 section keys against `pages/Settings.tsx`, so an upstream sync that renames a section leaves dead deep links. The module-level diff cache holds the full config and RJSF schema for the rest of the session after leaving Settings.
- **Fix:** A vitest asserting set equality with `settingsGroups`; clear the cache in the unmount effect of `use-settings-nav.ts`.
- **Effort:** S
- **Grade lift:** B− → B− (turns a rebase hazard into a red test)

#### C27 — Small a11y gaps in the share UI `[fork]`
- **Where:** `web/src/components/fork/ShareClipButton.tsx:117-121`, `web/src/pages/fork/ShareClipPage.tsx:107-111` (QR `div` with `aria-label` and no role); `web/src/components/navigation/ShareViewButton.tsx:11-18` (clipboard failure falls back to `window.prompt`; copied state never resets)
- **What's wrong:** `aria-label` on a role-less `div` is ignored by screen readers (`Sparkline.tsx:70-71` does it right); `window.prompt` is blocked in sandboxed iframes and unusable with assistive tech.
- **Fix:** `role="img"` on both QR containers; an inline read-only input with a `role="status"` message and a timed reset.
- **Effort:** S
- **Grade lift:** B− → B−

#### C28 — Overlay history can swallow a real back press `[fork]`
- **Where:** `web/src/lib/fork/overlay-history.ts:33-42,71-82`
- **What's wrong:** `pendingSelfPops` is incremented before an asynchronous `history.back()`; a user back press that lands first decrements the counter and closes nothing.
- **Fix:** Tag the expected entry (compare `currentState().overlayId`) instead of counting; extend `overlay-history.test.ts` with the interleaved case.
- **Effort:** S
- **Grade lift:** B− → B−

#### C29 — The new System AI/model views need a shared formatter and memoized series `[fork]`
- **Where:** `web/src/views/system/AIModelMetrics.tsx:82-91` (335 lines, four copies of a disclosure pattern), `AIModelGraphs.tsx:128-131,140-165,216,231`, `ServerPressure.tsx:9-12`, `StabilityIncidents.tsx:64,88-91`; `web/src/hooks/use-hour-rollover.ts` (no test)
- **What's wrong:** Three independent GiB/MiB formatters with hard-coded unit strings; `Math.max(...history)` spreads up to 8,640 samples; six chart series are rebuilt on every render; the incidents list key `${kind}:${scope}` is not unique; the hour-rollover timer ladder is the only new module without a test.
- **Fix:** One `formatBytes(value, locale)` in `utils/`; `reduce` for maxima; `useMemo` the series on `[history, id, range]`; add `row.started` to the key; a fake-timer test for the hook.
- **Effort:** M
- **Grade lift:** B− → B−

#### C4 — Kill four-level prop drilling in Events → EventView → DetectionReview → MotionReview `[fork]`, backlog
- **Where:** `web/src/pages/Events.tsx` → `views/events/EventView.tsx` (1,765 lines); `SearchDetailDialog.tsx` (1,955)
- **What's wrong:** Props pass through four levels with renames.
- **Fix:** `ReviewPageContext`; only as a local split when a feature touches these files.
- **Effort:** M
- **Grade lift:** B− → B

#### C6 — Break up the worst god components `[fork]`, backlog
- **Where:** `pages/Settings.tsx` (2,360), `components/overlay/detail/SearchDetailDialog.tsx` (1,955), `views/live/LiveCameraView.tsx` (1,848), `views/motion-search/MotionSearchView.tsx` (1,646), `pages/Exports.tsx` (1,577); 39 files over 800 lines, 108 over 400; in fork code `CommandPalette.tsx` (475), `SettingsNav.tsx` (442), `CameraHealthView.tsx` (424)
- **What's wrong:** Fetching, rules and layout fused; guaranteed rebase conflicts.
- **Fix:** Controller hook + sub-component folder, one file at a time, only when a feature needs it. For the fork's own three: `usePaletteItems()`, `useSettingsAnchors()`, and card sub-components.
- **Effort:** L
- **Grade lift:** B− → B

#### C7 — Reduce the 107 `exhaustive-deps` suppressions `[fork]`, backlog
- **Where:** `web/src` (167 `eslint-disable`, 107 for `react-hooks/exhaustive-deps`); not covered by `fork/type-ratchet.json`
- **What's wrong:** Deliberately stale closures whose correctness depends on comments; nothing stops the count rising.
- **Fix:** Add the count to the ratchet first (S), then stable callbacks or derived state.
- **Effort:** M
- **Grade lift:** B− → B

---

## D — Testing & Reliability — B

Up from B−. Latest green run on `next`: 508 vitest tests in 77 files, 598
e2e tests passing across 54 specs (25 under `specs/fork/`) in three shards,
1,343 backend tests in 128 files plus 162 tests for the fork's scripts.
Fixtures are validated against the OpenAPI spec in `globalSetup` (D9), every
fork backend module is tested including the migration's rollback, and
SonarCloud gates new code at 80% (83.5% now; 50.2% overall with browser
coverage merged). Not B+: the tracking pipeline is still untested (D4), no
visual regression or tablet project (D6, D3), unit line coverage is 13.4%
(web) and 40% (Python) with no floor of their own, and two flaky e2e tests
pass on the CI retry.

- ~~D1~~ ✓ done 2026-09-10. `web/__test__/test-setup.ts`, CI step
- ~~D2~~ ✓ done 2026-09-11. e2e for Settings save, camera wizard, zone editing, motion search
- ~~D5~~ ✓ done 2026-09-10. vitest v8 coverage in CI
- ~~D8~~ ✓ done 2026-09-10. `coverage run -m unittest` in `fork/scripts/py-checks.sh:25-38`, XML uploaded, fed to Sonar
- ~~D9~~ ✓ done 2026-09-11. `web/e2e/scripts/validate-fixtures.mjs` (Ajv against 200 schemas)
- ~~D10~~ ✓ done 2026-09-11. Software-decoding fallback (`frigate/video/hwaccel_fallback.py`, 20 tests; open defect → B5)
- ~~D11~~ ✓ done 2026-09-11. Restart log with reasons (`frigate/video/restart_log.py`, 13 tests)
- ~~D12~~ ✓ done 2026-09-11. No doubled punctuation (`restart_log.py:158`)
- ~~D13~~ ✓ done 2026-09-11. Circular-progress timings
- ~~D14~~ ✓ done 2026-09-11. Camera Health thresholds, 7-day remembered fallback
- ~~D15~~ ✓ done 2026-09-11. Frame-rate chart seeded from `/stats/history`
- ~~D16~~ ✓ done 2026-09-11. Mock `/api/stats/history`
- ~~D19~~ ✓ done 2026-09-11. Layout-only tests selected by tag (`grepInvert`; residue → D50)
- D17, D18, D20 to D47: see `FORK.md`

#### D4 — Test the core tracking pipeline `[BE] [upstream]`
- **Where:** `frigate/track/object_processing.py` (no test imports `TrackedObjectProcessor`); the dispatcher half is started in `frigate/test/test_dispatcher_runtime_state.py` (30 tests)
- **What's wrong:** The detection-to-event path, the product's core, has no unit tests.
- **Fix:** Fixture-driven synthetic detections through `TrackedObjectProcessor`: object lifecycle, zone entry, stationary handling, end-of-event publish.
- **Effort:** M
- **Grade lift:** B → B+

#### D48 — Coverage floors of the project's own `[both] [fork]`
- **Where:** `web/vite.config.ts:138-148` (no `thresholds`), `.coveragerc` (no `fail_under`)
- **What's wrong:** Only Sonar's new-code condition gates coverage; overall numbers (13.4% web lines, 40% Python) can fall without a red check, and the gate depends on a third-party token (I30).
- **Fix:** Ratchet files in the style of `fork/type-ratchet.json`: current value minus 1 for web and Python, stricter per-directory floors for `src/lib/fork/**` and `src/hooks/fork/**`.
- **Effort:** S
- **Grade lift:** B → B

#### D49 — Fix the two flaky e2e tests and stop the retry hiding them `[FE] [fork]`
- **Where:** `web/e2e/specs/live.spec.ts`, `classification.spec.ts` ("filtering by a class with a dash"); `web/e2e/playwright.config.ts:22` (`retries: CI ? 1 : 0`)
- **What's wrong:** The latest run reported 2 flaky tests; a second run showed 1. The retry turns them green, so nobody sees them.
- **Fix:** Repair both; read the JSON report in CI and annotate (or fail on `next`) when `flaky > 0`.
- **Effort:** S
- **Grade lift:** B → B

#### D50 — Six run-time viewport skips remain in the fork's specs `[FE] [fork]`
- **Where:** `web/e2e/specs/fork/camera-wizard.spec.ts:136`, `motion-search.spec.ts:75,121`, `settings-save.spec.ts:14,46`, `zone-editing.spec.ts:44`
- **What's wrong:** D19 missed them, so they still count among the 95 skips in every run.
- **Fix:** Convert to `@desktop-only`/`@mobile-only` tags; make `web/e2e/scripts/lint-specs.mjs` reject `test.skip(` under `specs/fork/`.
- **Effort:** S
- **Grade lift:** B → B

#### D6 — Visual regression screenshots `[FE] [fork]`
- **Where:** `web/e2e/playwright.config.ts` (no `toHaveScreenshot` anywhere); fork UI in `web/src/components/fork/`, `themes/fork-appearance.css`
- **What's wrong:** A rebase or dependency bump can silently undo polish and every functional test still passes. With 56 UI fixes shipped since the last audit, this is where regressions will come from.
- **Fix:** A `visual` project, about 8 views × desktop/mobile on mocked data, dynamic regions masked, `maxDiffPixelRatio` about 0.01; Linux baselines produced by a `workflow_dispatch` input on "Fork - Checks".
- **Effort:** M
- **Grade lift:** B → B+ (with D4)

#### D3 — Add a tablet viewport to the e2e matrix `[FE] [fork]`
- **Where:** `web/e2e/playwright.config.ts:41-58` (desktop 1920×1080 and an Android phone 412×915 only)
- **What's wrong:** The 700 to 1,100 px range, where UA layout breaks, is untested.
- **Fix:** 1024×768 project; ships with A1.
- **Effort:** S
- **Grade lift:** B → B (prerequisite for A1)

#### D7 — Refresh e2e mocks from real responses `[FE] [fork]`, backlog
- **Where:** `web/e2e/fixtures/` (D9 validates shape; D20 hand-aligned the data; no recording script)
- **What's wrong:** Schema-valid mocks can still be unrealistic.
- **Fix:** Record responses from the demo stack into fixtures with a script; diff on upstream sync.
- **Effort:** S
- **Grade lift:** B → B (fidelity)

---

## E — Security — B+

Holds at B+, close to A−. The scan backlog is gone: no advisory is open
against a runtime dependency in the image (`npm audit --omit=dev`: 0), the 3
critical CodeQL alerts were traced and dismissed with written reasons or fixed
(the Reolink SSRF got a real allowlist in `frigate/api/camera.py`), secret
scanning, push protection and gitleaks are on, and every route has one auth
gate checked at startup. The new public share feature gets the hard parts
right (192-bit tokens, expiry on both routes, camera access checked at
creation, nginx allows only GET without auth, 10 tests). It does not reach A−
because that same feature shipped without its operational half: the clip
window is unbounded for an event that never closes, the one unauthenticated
route spawns ffmpeg with no rate limit, and links cannot be listed or
revoked. CSP is still report-only, and one CodeQL alert in fork code is open.

- ~~E1~~ ✓ done 2026-09-10. `security_headers.conf`, HSTS, CSP report-only
- ~~E2~~ ✓ done 2026-09-10. One auth gate per route, startup assertion + test
- ~~E3~~ ✓ done 2026-09-10. `safe_join` in `preview_thumbnail`
- ~~E4~~ ✓ done 2026-09-10. CodeQL triage: 29 dismissed with written comments, 9 fixed (residue → E17, E18, E19)
- ~~E5~~ ✓ done 2026-09-11. Shipped dependency advisories patched; 145 remaining alerts are in `docs/` (125), unbuilt TensorRT manifests (16), dev-only vitest (2) and the build stage (2 → F7)
- E7 to E14: see `FORK.md`

#### E15 — Bound what a public share link can serve `[fork]`
- **Where:** `frigate/api/fork_share.py:168-171,204-215`; `frigate/api/media.py:477-514,552-603`; `docker/main/rootfs/usr/local/nginx/conf/nginx.conf:24,319-328`
- **What's wrong:** (1) When `event.end_time is None` the clip ends at `datetime.now()`, evaluated per request, so a link to an event that never closed serves everything that camera recorded since, without authentication, and it grows. (2) The route is `allow_public()`; every GET writes a playlist and spawns ffmpeg, and nothing limits it (slowapi is bound only to login at `frigate/api/auth.py:908,917,1044`; no `limit_req` in any nginx conf). One leaked link can exhaust the NVR's CPU. (3) The token is written to the nginx access log, which `/api/logs/nginx` serves.
- **Fix:** Clamp `end_ts = min(now, start + MAX_SHARE_CLIP_SECONDS)` and refuse to create a share for a longer span; `asyncio.Semaphore(2)` around the clip route (pattern at `frigate/api/stream_diagnostics.py:21`) plus `limit_req`/`limit_conn` on `^/api/fork/share/`; mask the token in that location's log format. Tests for the clamp and the 429.
- **Effort:** S
- **Grade lift:** B+ → A− (with E16)

#### E16 — List, revoke and switch off share links on the server `[fork]`
- **Where:** `frigate/api/fork_share.py:77-127` (three routes, none destructive; no quota); `web/src/fork/flags.ts` (`clipSharing` is frontend-only); router always mounted in `frigate/api/fastapi_app.py`; pruning only at 7 days past expiry (`frigate/events/share_links.py:15-29`)
- **What's wrong:** Any viewer can publish footage for up to 7 days; the link survives that user being deleted or losing camera access; an admin can neither see nor kill it; turning the feature "off" only hides a button.
- **Fix:** `GET /fork/share` (own links; admin sees all), `DELETE /fork/share/{token}` for creator or admin, a per-user cap on active links, a server-side setting that disables creation and public reads, delete a user's links with the user, and re-check the creator's camera access at read time (also compare `link.camera` to `event.camera`). A small "Active links" list in the share dialog.
- **Effort:** M
- **Grade lift:** B+ → A− (with E15)

#### E17 — Close the open code-scanning findings `[fork]`
- **Where:** CodeQL #51 `js/prototype-pollution-utility` at `web/src/lib/fork/zone-rename.ts:34-57` (open since 2026-09-15); 4 `actions/missing-workflow-permissions` alerts re-raised under new numbers in `ci.yml`/`release.yml`; SonarCloud reports 10 open vulnerabilities on `next`
- **What's wrong:** The Security tab is only a signal while it is at zero; fork code should not carry an open alert.
- **Fix:** Skip `__proto__`, `constructor` and `prototype` in `setPath`/`mergeInto` with a unit test; re-dismiss the workflow alerts with the E4 reasoning; triage the 10 Sonar vulnerabilities (fix or mark with a reason) and record them in E19's file.
- **Effort:** S
- **Grade lift:** B+ → B+

#### E18 — Two small input hardenings `[fork, upstreamable]`
- **Where:** `web/src/pages/fork/ShareClipPage.tsx:38-45` (route param interpolated into the request path unvalidated); `frigate/util/services.py:1023` (`ffprobe_stream` passes the user-supplied path as a bare positional argument)
- **What's wrong:** A crafted `/share/..%2F..%2Fconfig` link makes the victim's browser send an authenticated same-origin GET to another API path (nothing is returned to the attacker, but it should not be possible). A path starting with `-` is parsed as an ffprobe option on the admin-only route.
- **Fix:** Test the token against `/^[A-Za-z0-9_-]{8,64}$/` before requesting, else show the missing state; pass `-i` before the path (or reject a leading `-`) with a test.
- **Effort:** S
- **Grade lift:** B+ → B+

#### E19 — Keep the triage record in the repo `[fork]`
- **Where:** dismissal reasons live only in GitHub alert comments and one `FORK.md` row; no `SECURITY.md`
- **What's wrong:** The reasoning is lost if alerts are re-raised (it already happened to 4) or the repo moves, and reporters have no contact path.
- **Fix:** `fork/SECURITY-TRIAGE.md` (alert, rule, verdict, reason) and a short `SECURITY.md`.
- **Effort:** S
- **Grade lift:** B+ → B+

#### E6 — Move CSP from report-only to enforced `[upstream]`, backlog
- **Where:** `docker/main/rootfs/usr/local/nginx/conf/security_headers.conf:21` (`Content-Security-Policy-Report-Only`, includes `'unsafe-inline' 'unsafe-eval'`, no `report-uri`/`report-to`)
- **What's wrong:** The policy protects nothing, and with no collector its violations are visible only in a browser console, so there is no evidence to tighten it with. Release notes markdown can load third-party images until it is enforced.
- **Fix:** A log-only `report-uri` endpoint (or collect in the demo stack) across all pages (monaco workers, blob players, go2rtc WebRTC), tighten, then enforce.
- **Effort:** M
- **Grade lift:** A− → A (once E15/E16 are done)

---

## F — Dependencies & Tech Currency — B−

Holds at B−. Security patching is good, react-router 7 was taken (PR #49,
`fork/ROUTER7-BUNDLE-BUDGET.md`), axios is current, the fork's dev tools
install from hash-pinned locks, and binaries are checksummed. But the gap to
current majors widened (TypeScript 5.9 vs 7, Vite 6 vs 8, Vitest 3 vs 5 with
an open dev advisory, i18next 24 vs 26, apexcharts 3 vs 7, jsdom 24 vs 30),
F5 is untouched, the image still builds the web app on EOL `node:20`, and a
fork-pinned `setuptools` carries a high advisory with its fix PR unmerged.
Dependabot is security-only by design, so currency depends on upstream syncs
(broken, I27) and the manual F4 phase.

- ~~F1~~ ✓ done 2026-09-10. ESLint 9 flat config
- ~~F2~~ ✓ done 2026-09-10. go2rtc/ffmpeg SHA256, pinned actions
- ~~F3~~ ✓ done 2026-09-10. mypy out of runtime, single OpenCV wheel
- ~~F6~~ ✓ done 2026-09-11. Web minor/patch refresh within majors

#### F7 — Merge the `setuptools` fix `[fork]`
- **Where:** `docker/main/requirements.txt:3`, `docker/main/requirements.lock:17` (`setuptools == 77.0.3`, fork-introduced; high advisory below 78.1.1); Dependabot PR #50 open
- **What's wrong:** A known-vulnerable build-stage pin with a ready fix sitting unmerged.
- **Fix:** Merge #50 or regenerate the lock at 78.1.1 or later; confirm scikit-build still builds the wheels.
- **Effort:** S
- **Grade lift:** B− → B−

#### F8 — Build the web app on a supported Node `[fork, upstreamable]`
- **Where:** `docker/main/Dockerfile:362` (`node:20`, EOL April 2026); CI uses Node 22 (`.github/actions/fork-web-setup/action.yml:8`); `actions/download-artifact@v4` and `actions/setup-python@v5.4.0` warn about the Node 20 runtime
- **What's wrong:** The shipped bundle is built on a runtime that CI never tests, and that no longer gets security fixes.
- **Fix:** `node:22` (digest-pinned) in the Dockerfile; bump and re-pin the two actions.
- **Effort:** S
- **Grade lift:** B− → B

#### F5 — Retire abandoned packages and document the patches `[fork, upstreamable]`
- **Where:** `web/package.json` (`strftime`, `nosleep.js`, `vite-plugin-monaco-editor` with its own patch; 9 `overrides`), `web/patches/*.patch` (3 patches, no README), repo-root stub `package-lock.json` (86 bytes, still tracked)
- **What's wrong:** Dormant dependencies and unexplained patches and overrides that will bite on upgrade.
- **Fix:** Replace the three small deps; `web/patches/README.md` covering each patch and override (lands with H3); delete the stub lockfile.
- **Effort:** S
- **Grade lift:** B− → B−

#### F9 — Hash-lock the main wheel set `[fork]`
- **Where:** `docker/main/requirements-wheels.txt` (unhashed `==X.*` ranges; the three build-stage locks already use `--require-hashes`)
- **What's wrong:** Two builds of the same commit can ship different wheels; a bad upstream patch release lands silently in the image.
- **Fix:** `pip-compile --generate-hashes` to `requirements-wheels.lock`, installed with `--require-hashes`, checked by the existing `dev-lock-check.py` pattern.
- **Effort:** M
- **Grade lift:** B− → B

#### F4 — Frontend major bumps `[fork]`, backlog, scheduled last
- **Where:** `web/package.json`: TypeScript 5.9 (7.0), Vite 6.4 (8.3), Vitest 3.2 (5.0, open dev advisory), ESLint 9 (10), Tailwind 3.4 (4.3), i18next 24 (26) / react-i18next 15 (17), date-fns 3 (4), zod 3 (4), apexcharts 3 (7), jsdom 24 (30). ~~react-router 6 → 7~~ ✓ done (PR #49)
- **What's wrong:** One to six majors behind each, and the gap widened since the last audit.
- **Fix:** One PR per major or tightly coupled group. Toolchain first (I11), then runtime libraries by alert and risk, Tailwind 4 last. Each PR records before/after gates. Python pins stay upstream-owned.
- **Effort:** L
- **Grade lift:** B− → B

---

## G — Performance & Scalability — C+

Down from B−. The shipped wins hold (bounded search SQL G4, `CacheFileTracker`
G6, threadpool handlers G3, a CI bundle budget G7), but every open item from
the last audit is still open, and the trend reversed on two fronts. Eager JS
went from 305 kB gzip to 393 kB and the budget was raised to fit
(`fork/bundle-budget.json`: 412,650). Sampling the backend hot paths found
costs that survived two audits: `/events/explore` issues 2N+1 queries and
reads thumbnail blobs it discards, both bulk deletes are sequential with
unchunked `IN` lists, `preview_gif`/`preview_mp4` scan a directory on the
event loop, and `review_summary` full-scans on every poll with zero
ETag/304 handling anywhere in `frigate/api/`. No list is virtualized, 25 of
35 `<img>` are not lazy, and nothing measures real interaction latency.

- ~~G1~~ ✓ done 2026-09-10. Explicit icon map, lazy settings menus
- ~~G2~~ ✓ done 2026-09-10. SWR global policy
- ~~G3~~ ✓ done 2026-09-10. Sync handlers are `def`; `asyncio.to_thread`; ruff `ASYNC` (`delete_camera` moved behind a thread since)
- ~~G4~~ ✓ done 2026-09-10. SQL ORDER BY/LIMIT, bounded vector candidates
- ~~G5~~ ✓ done 2026-09-10. Lazy players, `manualChunks`, memoized cards (partly undone → C20)
- ~~G6~~ ✓ done 2026-09-10. `frigate/record/cache_tracker.py`
- ~~G7~~ ✓ done 2026-09-10. `web/scripts/fork/bundle-budget.mjs` in CI and `make check`

#### G13 — `/events/explore` is 2N+1 queries and reads blobs it throws away `[upstream]`
- **Where:** `frigate/api/event.py:389-425`
- **What's wrong:** One `DISTINCT label` query, then per label an unprojected `Event.select()` (pulls the `thumbnail` BLOB and `data` for every row) and a separate `.count()`. With 20 labels that is 41 queries on the Explore home view.
- **Fix:** One windowed query (`ROW_NUMBER() OVER (PARTITION BY label ORDER BY start_time DESC)`) with an explicit column list, plus one `GROUP BY label` count. Test asserts the query count.
- **Effort:** M
- **Grade lift:** C+ → B− (with G14, G15)

#### G14 — Bulk deletes are sequential, unchunked and not atomic `[upstream]`
- **Where:** `frigate/api/event.py:1774-1781,1800-1830` (`DELETE /events/` loops `delete_single_event`, two thread hops and 3+ queries per event); `frigate/api/review.py:519-561` (one `Recordings` query per review at `:537-550`, files unlinked at `:553`, then an unchunked `Recordings.id << recording_ids` at `:557`)
- **What's wrong:** The fork's Explore multi-select (UI10) makes 500-event deletes a normal action: about 1,000 thread hops. In `delete_reviews` a large id list can exceed SQLite's variable limit after the files are already gone, leaving rows that point at missing files.
- **Fix:** Fetch in chunks of 500, check camera access once per distinct camera, delete rows in batched statements inside one `to_thread`, and delete rows before unlinking files.
- **Effort:** M
- **Grade lift:** C+ → B− (with G13, G15)

#### G15 — Preview endpoints scan a directory on the event loop `[upstream]`
- **Where:** `frigate/api/media.py:1381,1474` (`preview_gif`), `:1554,1663` (`preview_mp4`): `os.scandir(preview_dir)` plus a sort over every camera's preview frames, inline in `async def`
- **What's wrong:** Thousands of dirents per request block every other API request; ruff's `ASYNC240` is waived for "metadata calls", which this is not.
- **Fix:** `await asyncio.to_thread(...)` the selection and glob by the `preview_{camera}-` prefix.
- **Effort:** S
- **Grade lift:** C+ → B− (with G13, G14)

#### G17 — Eager bundle grew 29% and the budget followed it `[fork]`
- **Where:** `fork/bundle-budget.json` (`eagerGzipBytes` 412,650; measured 393 kB, was 305 kB after G1/G5); `fork/ROUTER7-BUNDLE-BUDGET.md`; shell-level fork imports in `web/src/App.tsx` and the navigation (command palette, inbox, update notices, appearance)
- **What's wrong:** The budget is measured + 5%, so each raise legitimizes the growth. Part is react-router 7, but fork features that open on demand (palette, inbox panel, release notes dialog with `react-markdown`) load for every user at startup.
- **Fix:** Run the visualizer on the eager graph; `React.lazy` the palette body, inbox panel, release notes dialog and QR encoder behind their triggers; then lower the budget to the new measurement and require a written reason in the PR for any raise.
- **Effort:** M
- **Grade lift:** C+ → B−

#### G9 — Virtualize the card grids and lazy-load images `[fork, upstreamable]`
- **Where:** `web/src/views/search/SearchView.tsx`, `views/events/EventView.tsx`, `views/recording/RecordingView.tsx` (no virtualization library in `package.json`, though the Logs page already uses `virtua`); 25 of 35 `<img>` lack `loading="lazy"`
- **What's wrong:** Long Review/Explore sessions grow the DOM and image memory without bound.
- **Fix:** `virtua` (already a dependency) for the three grids behind a flag; `loading="lazy" decoding="async"` on non-critical images.
- **Effort:** M
- **Grade lift:** C+ → B−

#### G10 — Immutable, precompressed static assets `[upstream]`
- **Where:** `docker/main/rootfs/usr/local/nginx/conf/nginx.conf:337-342` (`/assets/`: `expires 1y` + `Cache-Control "public"`, no `immutable`); `:33-37` (gzip on the fly, no `gzip_static`)
- **What's wrong:** Reloads revalidate every hashed chunk; nginx recompresses the same files per request. Two lines of config, open since the first audit.
- **Fix:** `Cache-Control: public, max-age=31536000, immutable` for `/assets/`; emit `.gz` at build and enable `gzip_static`.
- **Effort:** S
- **Grade lift:** C+ → C+ (repeat-visit latency, server CPU)

#### G11 — HTTP caching for summary endpoints `[upstream]`
- **Where:** `frigate/api/review.py:201` (`review_summary`), `frigate/api/record.py:62,123`; zero `ETag`/`304` handling in `frigate/api/`
- **What's wrong:** Summaries are recomputed and re-sent on every poll and focus even when nothing changed.
- **Fix:** An ETag from the newest relevant row timestamp with a 304 path; measure in the demo stack first.
- **Effort:** M
- **Grade lift:** C+ → B−

#### G8 — Put the Settings form chunk on a diet `[fork, upstreamable]`
- **Where:** `web/src/components/config-form/ConfigForm.tsx:3` (static `@rjsf/validator-ajv8`, runtime schema compile; rides the lazy Settings chunk, about 246 kB gzip)
- **What's wrong:** Every Settings visit downloads and compiles a schema validator before the form is usable.
- **Fix:** Precompile validators at build time (ajv standalone) or load the validator on first validation; measure with G7's script.
- **Effort:** M
- **Grade lift:** C+ → C+

#### G16 — `review_summary` filters cannot use an index `[upstream]`, backlog
- **Where:** `frigate/api/review.py:238-251` (`data["objects"].cast("text") % '*"label"*'`, OR-ed per label)
- **What's wrong:** A `LIKE` over a JSON text cast full-scans `reviewsegment` on the most-polled expensive endpoint.
- **Fix:** Profile first; then a normalized `review_segment_label` side table or a generated column with an index.
- **Effort:** L
- **Grade lift:** B− → B

#### G12 — Web-vitals budget on key pages `[fork]`, backlog
- **Where:** no LCP/INP/CLS measurement anywhere (`web-vitals`, `PerformanceObserver`: zero hits)
- **What's wrong:** Bundle size is a proxy; real interaction latency is unmeasured.
- **Fix:** `web-vitals` in a Playwright run against the demo stack (I7 exists now); fail on regression.
- **Effort:** M
- **Grade lift:** B− → B

---

## H — Documentation & Onboarding — C+

Holds at C+. `FORK.md` is a complete ledger of every shipped change and the
GitHub Releases have generated notes; that part is excellent. Everything
around it is losing ground to the pace of work: the root `README.md` never
says this is a fork or where its image is, `AGENTS.md`/`CLAUDE.md` and
`CONTRIBUTING.md:73` describe upstream's branch model, this report was 422
commits stale with about 20 finished items shown open, `fork/PLAN.md` and
`PLAN2.md` carry statuses from 2026-09-11, three places still name the rc2
base, `fork/` has 14 unindexed `SONAR-*.md` files, and H3, H4 and H5 are
untouched.

- ~~H1~~ ✓ done 2026-09-10
- ~~H2~~ ✓ done 2026-09-10 (its gate list is stale again → H7)
- ~~H6~~ ✓ done 2026-09-17. Fork block at the top of `README.md`: what the fork is, ledger, Releases, images, branch model, where upstream lives
- ~~H7~~ ✓ done 2026-09-17. "Fork workflow" section in `AGENTS.md` (worktrees, `next`, `make promote`, ledger IDs, gates); `CONTRIBUTING.md` points at it and `make check`

#### H8 — Reconcile the plans and the base version `[fork]`
- **Where:** `fork/PLAN.md:13` (says I12, means I13; 4b D2 unticked; "in progress on `polish2`"), `fork/PLAN2.md:9-18,482` (status dated 09-11, PR #29 "in review", "Dependencies: not started"), `FORK.md:10-13,42` ("rebased onto upstream/dev", "one item = one commit", "after v0.18.0-rc2"), `fork/SONAR-CI.md:12` (says Playwright coverage does not count); rc2 base in `fork/demo/Dockerfile:4`, `fork/demo/README.md:20`, `fork/README.md:25`, `.github/workflows/fork-upstream-sync.yml:126` while `Makefile:64` and `fork/Dockerfile.test:4` use 0.18.0
- **What's wrong:** A dozen statements contradict the ledger, and the demo runs on a different base than the tests.
- **Fix:** Archive finished plan sections and keep one current queue; reword `FORK.md`'s rules to the actual practice; one `fork/BASE_VERSION` file read by the Makefile, both Dockerfiles and the sync workflow.
- **Effort:** S
- **Grade lift:** C+ → C+

#### H9 — Keep this report honest automatically, and index `fork/` `[fork]`
- **Where:** `fork/GRADE-REPORT.md` vs `FORK.md` (117 ledger IDs were unknown to the report; about 20 done items showed as open); `fork/SONAR-*.md` (14 files, about 1,660 lines) and 5 CSVs at the top of `fork/`; `fork/README.md` (54 lines; omits `make demo-audit`, `fork/monitoring`, `fork/benchmarks`, `Dockerfile.rootless-test` and 12 of the scripts); `FORK.md` (126 KB, 184 unsorted rows, cells up to 2,211 characters)
- **What's wrong:** The report only stays true if someone remembers to edit it, and the working folder is hard to navigate.
- **Fix:** A test next to `fork/scripts/test_release_notes.py` that fails when an audit item marked done in `FORK.md` is still an open heading here; move the Sonar write-ups to `fork/archive/sonar/` keeping `SONAR-CI.md`; extend `fork/README.md`; sort the ledger by ID (or split it per category with an index).
- **Effort:** M
- **Grade lift:** C+ → B−

#### H3 — Frontend, e2e and patches READMEs `[fork]`
- **Where:** `web/README.md` (25 lines of Vite template for 157k lines of TypeScript), no `web/e2e/README.md`, no `web/patches/README.md`
- **What's wrong:** Directory rules (`fork/` folders, flags), the base-path sentinel, e2e mocking and tags, fixture validation, the i18n workflow, generated API types and the patches are undocumented.
- **Fix:** Write the three READMEs.
- **Effort:** S
- **Grade lift:** C+ → B−

#### H5 — Deploy and rollback runbook for the fork image `[fork]`
- **Where:** `fork/README.md` (build and test only); the image name appears only in `FORK.md:28`
- **What's wrong:** Nothing tells the owner how to switch a Frigate stack to `ghcr.io/jtn0123/frigate:<tag>` and back, which tag to pin, or what to check after. The server now runs this image.
- **Fix:** Docs only; agents never execute it. Include pinning a `fork/*` release tag instead of `:main`, the DB backup before a migration, and the rollback note for migration 036 and later.
- **Effort:** S
- **Grade lift:** C+ → C+ (operational clarity)

#### H4 — Architecture page `[upstream]`, backlog
- **Where:** `docs/docs/development/` (only the two contributing pages)
- **What's wrong:** Process topology, frame lifecycle and ZMQ topics are undocumented.
- **Fix:** One page with a mermaid diagram and a topic table (include the WebSocket classifier rule).
- **Effort:** M
- **Grade lift:** C+ → B−

---

## I — Developer Experience & Tooling — B

Holds at B. The tooling is strong: `make check`/`check-fast`, ready worktrees,
hash-locked dev dependencies, checks in about 9 minutes, a required "Checks
passed" status on `next`, releases with notes generated from commits, ROCm
images, and ratchets for types and bundle size. It does not reach B+ because
the automation is failing quietly: the upstream-sync bot has failed every day
since 2026-09-13 for a secret that was never created (`dev` is 186 commits
behind), the Sonar gate passes on PRs and then fails on `next` (6 of the last
12 pushes), `main` has no required check, the Sonar token expires on
2026-10-11, and the mypy ratchet has not advanced.

- ~~I1~~ ✓ done 2026-09-10. Pre-commit, CI caching
- ~~I2~~ ✓ done 2026-09-10. `make` inner-loop targets
- ~~I4~~ ✓ done 2026-09-10. ruff `S`
- ~~I5~~ ✓ done 2026-09-10. `ImportMetaEnv` (`web/src/vite-env.d.ts:3-4`), `E2E_PORT` documented
- ~~I6~~ ✓ done 2026-09-10. `fork-upstream-sync.yml` (currently failing → I27)
- ~~I7~~ ✓ done 2026-09-10. Local demo stack
- ~~I9~~ ✓ done 2026-09-10. Faster CI (354 s → 206 s at the time)
- ~~I10~~ ✓ done 2026-09-10. `make check`, `make wt`
- ~~I12~~ ✓ done 2026-09-11. actionlint SC2016
- ~~I13~~ ✓ done 2026-09-11. Releases from `main` with generated notes
- ~~I14~~ ✓ done 2026-09-11. SonarCloud findings in scripts, CI and backend files
- ~~I28~~ ✓ done 2026-09-17. The red pushes were a merge that skipped pull request analysis (I26's findings) and scans without browser coverage, not the new-code period; every push to `next` now runs the web jobs, a failed gate names its conditions, evidence and decision in `fork/SONAR-CI.md`
- ~~I32~~ ✓ done 2026-09-17. `check.sh` warns when HEAD is more than 20 commits behind `origin/next`; `.codex-output/` and `fork/demo/screenshots/compare/` ignored
- I15 to I26: see `FORK.md` (I16, I17 unused)

#### I27 — Give the upstream-sync bot its token `[fork]`
- **Where:** repository secrets (only `SONAR_TOKEN` exists; `FORK_SYNC_TOKEN`, which I18 added support for, was never created); `.github/workflows/fork-upstream-sync.yml`; issue #61 open since 2026-09-15
- **What's wrong:** Every scheduled run since 2026-09-13 fails with "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission". `dev` has been frozen at 2026-09-06 and upstream is 186 commits ahead; conflicts pile up unseen, which is what I6 existed to prevent.
- **Fix:** Owner creates a fine-grained token (contents + workflows write) as `FORK_SYNC_TOKEN`. In the workflow, fail in the first step with a clear message when the secret is empty.
- **Update 2026-09-17:** The workflow part shipped: the run stops in its first step when the secret is empty and names the token to create, the "Upstream sync failed" issue carries the same steps, and the new-tag base is `v0.18.0`. Still open for the owner: create the fine-grained token (Contents and Workflows read and write on `jtn0123/frigate`) and save it as `FORK_SYNC_TOKEN`; steps in `fork/README.md`, "Owner setup".
- **Effort:** S
- **Grade lift:** B → B+ (I28 is done)

#### I29 — Require the check on `main` too `[fork]`
- **Where:** repository rulesets ("next: require quality checks" covers `refs/heads/next` only; `main` has only the no-deletion rule)
- **What's wrong:** `fork/scripts/promote.sh` enforces green checks by convention; a direct push to `main` builds and publishes the image the server pulls.
- **Fix:** Add `Checks passed` as a required status on `main`, or restrict updates to fast-forwards from `next`.
- **Effort:** S
- **Grade lift:** B → B

#### I30 — The Sonar token expires on 2026-10-11 `[fork]`
- **Where:** `SONAR_TOKEN` secret (expiry noted in `fork/SONAR-CI.md`)
- **What's wrong:** On that day the `sonar` job, and with it the required check, fails for every PR.
- **Fix:** Rotate now; add a CI step that warns when the documented expiry is within 14 days.
- **Update 2026-09-17:** The reminder shipped: `fork/scripts/sonar-token-expiry.py` reads the date from `fork/sonar-token.env`, and the `sonar` job warns from 14 days before it (2026-09-27) and fails with a clear error once it has passed. Still open for the owner: rotate the token before 2026-10-11 and update the date; steps in `fork/README.md`, "Owner setup".
- **Effort:** S
- **Grade lift:** B → B

#### I31 — Pre-commit should cover what CI checks `[fork]`
- **Where:** `.pre-commit-config.yaml` (ruff `files:` pattern skips `fork/scripts`, `fork/audio_trial`, `fork/monitoring`; no actionlint or shellcheck hook, although I12 and I14 were exactly those findings)
- **What's wrong:** Failures in the fork's own Python and workflows show up only in CI, 9 minutes later.
- **Fix:** Add `fork` to the ruff pattern; add actionlint and shellcheck hooks.
- **Effort:** S
- **Grade lift:** B → B

#### I33 — Guard ledger IDs against reuse `[fork]`
- **Where:** git history (D16 has 3 meanings, I13 has 4); `fork/scripts/release_notes.py` groups by ID
- **What's wrong:** Release notes merge unrelated commits under one ID, and a reused ID makes "do D16" ambiguous.
- **Fix:** An alias map (commit SHA → real ID) read by `release_notes.py`; a commit-msg hook that rejects a new ID already present in `FORK.md` with a different title.
- **Effort:** S
- **Grade lift:** B → B

#### I34 — Prune merged branches `[fork]`
- **Where:** 45 remote branches, 63 PRs merged; several prunable local worktrees
- **What's wrong:** Finished `section/*` and agent branches accumulate and hide the live ones.
- **Fix:** Enable "automatically delete head branches"; delete merged remotes once; `git worktree prune`.
- **Effort:** S
- **Grade lift:** B → B

#### I3 — Continue the mypy ratchet `[upstream]`
- **Where:** `frigate/mypy.ini:28-55` (`ignore_errors = true` for `api`, `config`, `detectors`, `embeddings`, `ptz`, `util`, `video`, tests, `whisper_online`); no wave landed since 2026-09-11
- **What's wrong:** The fork now writes most of its backend code inside `frigate/video/` and `frigate/api/`, which are unchecked; defects like B5 live there.
- **Fix:** Before the package waves, enable strict checking per fork-owned module (`frigate.video.restart_log`, `hwaccel_fallback`, `camera_outage`, `frigate.api.fork_*`, `frigate.fork.*`), which is cheap because that code is already annotated. Then PR-14's waves: `ptz`+`video`, `config`, `util`, `detectors`+`embeddings`, `api` last.
- **Effort:** L (first step S)
- **Grade lift:** B → B+

#### I8 — Overlay image for fast branch builds `[fork]`, backlog
- **Where:** `.github/workflows/fork-build.yml` (warm 6 to 17 minutes, cold up to 38)
- **What's wrong:** Low value while the server pulls `:main`, which needs the full build (owner decision 2026-09-10).
- **Fix:** Only if preview branches appear.
- **Effort:** M
- **Grade lift:** B → B

#### I11 — Toolchain trial: TypeScript 7, Vite 8, Vitest 5 `[fork]`, backlog, first step of F4
- **Where:** `web/package.json` (TypeScript 5.9.3, Vite 6.4, Vitest 3.2.7)
- **What's wrong:** Typecheck and build are the slowest web steps; Vitest 3 carries the only open web advisory.
- **Fix:** A measured trial on a throwaway branch; adopt only if the owner accepts the extra lockfile conflicts on upstream syncs.
- **Effort:** S (trial) / M (adopt)
- **Grade lift:** B → B (speed only)

---

## UX feature track

Product features, graded under C. IDs UI43 to UI99 (56 rows, UI59 unused)
are UI fixes and features defined in `FORK.md`.

| ID | Feature | Size | Status |
|----|---------|------|--------|
| ~~UI1~~ | Never a blank page (= C1) | S | ✓ done |
| ~~UI2~~ | Keyboard + screen-reader access (= C2) | M | ✓ done |
| ~~UI3~~ | Faster first paint (= G1/G5) | M | ✓ done |
| ~~UI4~~ | Honest error states (= C5) | S | ✓ done |
| UI5 | Layout follows the viewport (= A1, + D3) | M | not started (flag exists, no consumer → A7) |
| ~~UI6~~ | Command palette (Cmd/Ctrl+K) | S–M | ✓ done (`components/fork/CommandPalette.tsx`) |
| ~~UI7~~ | Settings navigation: scrollspy rail, search, diff before Save All | M | ✓ done |
| ~~UI8~~ | Timeline scrubber: snap, arrow keys, touch targets | M | ✓ done (`lib/fork/timeline-scrubber.ts`; bounded snap and slider role since UI73) |
| ~~UI9~~ | Shared event summary header (Review + Explore) | M | ✓ done |
| ~~UI10~~ | Bulk actions in Explore + undo for mark-reviewed | M | ✓ done (open defect → C20; server side → G14) |
| ~~UI11~~ | Share a clip: expiring link + QR | M | ✓ done (open items → E15, E16, C27) |
| ~~UI12~~ | Camera health cards | M | ✓ done |
| UI13 | Live layout memory + picture-in-picture | M | not started (flag exists, no consumer → A7) |
| ~~UI14~~ | Notification inbox with quiet hours | M | ✓ done (open defects → C21) |
| ~~UI15~~ | Theme controls: density, text size, OLED black | S | ✓ done |
| UI16 | Camera offline alerts (UI12 data → UI14 inbox) | M | queued; SV6 shipped the server-side outage notice, the inbox link is not built |
| UI17 | Storage forecast + retention simulator | M | queued |
| ~~UI18~~ | Installable mobile app polish | M | ✓ first step done (maskable icon, manifest) |
| UI19 | Kiosk / wall-display mode | M | backlog |
| UI20 | Performance advisor on System page | M | backlog |
| UI21 | Review triage keys (j/k, space, r, e, `?`) | S | backlog |
| UI22 | Morning digest card on Review | S | backlog |
| UI23 | Setup health checklist | S | backlog |
| UI24 | Last-event chip on Live tiles | S | backlog |
| UI25 | Tile quick actions | S | backlog |
| UI26 | Skip-idle playback + remembered speed | M | backlog |
| UI27 | Swipe to review on mobile | S | backlog |
| UI28 | Activity heatmap (hour × day) | M | backlog |
| UI29 | Date-range filter on Exports | S | backlog |
| UI30 | Connection banner on websocket loss | S | backlog |
| UI31 | Guided empty states | S | backlog |
| UI32 | Undo for destructive actions | M | backlog |
| UI33 | Export queue UX | S | backlog |
| UI34 | Saved and recent searches in Explore | S | backlog |
| UI35 | Zone editor UX (snap, undo/redo, numeric entry) | M | backlog |
| UI36 | Reduced motion + high-contrast theme | S | backlog |
| UI37 | Camera-group quick switch | S | backlog |
| UI38 | Copy diagnostics button | S | backlog |
| UI39 | Timeline hover previews | M | backlog |
| UI40 | Server-side camera-offline push | M | backlog (SV6 covers the notification half) |
| UI41 | Cross-camera stories | L | backlog |
| ~~UI42~~ | Update notices and What's new from the fork's releases | M | ✓ done (open item → B6) |
