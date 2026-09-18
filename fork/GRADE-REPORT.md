# Codebase Grade Report

**Project:** frigate, fork `jtn0123/frigate`, branch `next` @ 66774e9b6 (base upstream v0.18.0; `main` is promoted from `next`)
**Audited:** 2026-09-18 (third regrade; earlier: baseline of upstream `dev` and first regrade, both 2026-09-10 @ 752bc3047, second regrade 2026-09-17 @ edfdfcfa5)
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

**What changed since 2026-09-17.** Six PRs (#65 to #70), 20 commits, about
4,600 lines, 17 audit items closed: the three backend time-and-scale defects
(B5, B6, B7), the share feature's operational half (E15, E16), three hot
query paths (G13, G14, G15), the a11y lint lock (C9), the fork's front-door
docs (H6, H7) and the CI gate fixes (I28, I29, I32). Each closed item came
with tests (about 67 new backend tests). This audit re-checked every open
item against the code and reviewed the merged code itself, which added 11 new
items, all small: the fixes were sound but not flawless (B10 is a defect in
the B5 fix). The structural debt from the 09-17 audit is unchanged, and the
merge train itself exposed a process cost (I35, I36).

## Summary

| ID | Category | Baseline | 09-10 | 09-17 | Now | Open items |
|----|----------|----------|-------|-------|-----|------------|
| A | Architecture & Design | B− | B− | B | B | 5 |
| B | Backend Quality | B− | B | B | B+ | 4 |
| C | Frontend Quality | C | C+ | B− | B− | 13 |
| D | Testing & Reliability | C+ | B− | B | B | 7 |
| E | Security | B+ | B+ | B+ | B+ | 3 |
| F | Dependencies & Tech Currency | C+ | B− | B− | B− | 5 |
| G | Performance & Scalability | C+ | B− | C+ | B− | 6 |
| H | Documentation & Onboarding | C | C+ | C+ | C+ | 5 |
| I | Developer Experience & Tooling | C+ | B | B | B | 8 |
| **Overall** | | **B−** | **B** | **B** | **B** | **56** + UX track |

**What the grade branch added (2026-09-18).** E6 and G8 are done on top of the counts above, I3's first wave and G9's image half landed, and the rest of its work is ledger-only (I17, D25, D26, I16, E8, plus F10 and B12, which were this branch's F7 and B5 until `next` claimed those numbers for different items; the trunk keeps the number, and B5 was renumbered twice as `next` took B10 too). B12 is the `fork_updates` half only: `next`'s own share models and endpoints supersede the share half.

**Top 5 highest-leverage open fixes:** I27 (owner: add the secret), E18, G17, D48, I31

Update 2026-09-18 (later the same day): B10, B11, C20, C30, C31, D51, E20, E21, E22, I35, I36 and I37 landed on `next` in #73 to #76, and E17's code half with them. The category prose below was written before they did.

**Type safety at a glance.** Frontend: TypeScript `strict` gates the build and
`fork/type-ratchet.json` holds every escape hatch (`explicitAny` 23,
`tsExpectError` 14, `asUnknownAs` 25, floating and misused promises 0,
`no-unnecessary-condition` 1,482). API reads for config, review, events and
stats use types generated from the spec (`web/src/types/fork/api.gen.ts`,
11,234 lines). Backend: mypy still has `ignore_errors = true` for `api`,
`config`, `detectors`, `embeddings`, `ptz`, `util`, `video`, tests and
`whisper_online` (`frigate/mypy.ini:28-55`), so the fork's own new code in
`frigate/video/` and `frigate/api/` is unchecked; 125 `type: ignore` and 734
`Any` outside tests; 81 of 189 routes declare a `response_model`.

---

## A — Architecture & Design — B

Holds at B (lifted from B− by A5). The process model (ZMQ IPC
`frigate/comms/zmq_proxy.py`, shared-memory frames, a fail-closed WebSocket
classifier at `frigate/comms/ws.py:310`) is still the strongest part, and the
fork follows its own rule of adding files instead of editing them: 29 new
backend modules and 109 fork frontend files against 5 upstream backend files
with more than 100 changed lines. Held at B because nothing structural moved:
no service layer (`frigate/api/event.py` 2,354 lines, `media.py` 1,883; G13
to G15 moved about 75 lines out into new fork modules), 38 frontend files over 800 lines
(`web/src/pages/Settings.tsx` 2,360), UA sniffing went up (264 `isMobile`,
401 `isDesktop`), and `frigate/video/ffmpeg.py` (243 changed lines) and
`frigate/api/camera.py` (279) have become co-owned files.

- ~~A4~~ ✓ done 2026-09-11. `App` fetches config once
- ~~A5~~ ✓ done 2026-09-11. Generated `api.gen.ts`, `useApi`/`apiGet` for config/review/events/stats

#### A6 — Split `CameraWatchdog.run` before it grows again `[fork]`
- **Where:** `frigate/video/ffmpeg.py:366-672` (307 lines, up from about 230 upstream; B5 added the expiry branch at `:385-391`)
- **What's wrong:** One loop interleaves config updates, the hwaccel reset, enable and record transitions, the segment drain, backoff, detect liveness and stall checks, record staleness (SV3) and the outage tick (SV6). It is the largest fork-touched function and the worst rebase-conflict surface in the backend.
- **Fix:** Extract `_drain_segment_updates()`, `_check_detect_process(now, can_restart)` and `_check_record_processes(now)`; `run` drops to about 90 lines. Behavior unchanged; the existing watchdog tests cover it.
- **Effort:** M
- **Grade lift:** B → B (smaller rebase hunks)

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
- **Where:** `frigate/api/event.py` (2,354), `media.py` (1,883), `chat.py` (1,584), `app.py` (1,539), `camera.py` (1,344)
- **What's wrong:** Handlers hold business logic and query peewee directly; every router grew since the last audit.
- **Fix:** `frigate/services/<domain>.py`, one router at a time. `frigate/api/camera_config.py` (the extracted camera delete) and `frigate/api/fork_bulk.py` (G14) show the pattern.
- **Effort:** L
- **Grade lift:** B → B+

---

## B — Backend Quality — B+

Up from B. The three defects that held it there are fixed with tests: the
hardware-decoding retry now fires (B5), the update check no longer holds its
lock across an HTTP call (B6), and `RestartLog` is bounded (B7). The code
merged since the last audit was reviewed line by line and is sound: database
work and directory scans run off the event loop, id lists are chunked at 500,
bulk deletes check camera access before deleting anything, no exception text
reaches a response, the share API re-validates token, expiry and camera on
every request, and the new fork files have zero f-string log calls. The
review found one real defect in the B5 fix (B10, a recording restart every 7
days) and three edge cases (B11). What keeps it from A− is mostly upstream's:
108 of 189 routes have no `response_model`, and the logging rule is still
not enforced.

- ~~B1~~ ✓ done 2026-09-10. HTTPException renders `{success, message, detail}`
- ~~B3~~ ✓ done 2026-09-10. 25 `except Exception: pass` sites log; bare `except:` narrowed
- ~~B5~~ ✓ done 2026-09-18. `HwaccelFallback.maybe_expire` ends an expired switch on the next watchdog tick and restarts ffmpeg; one log snapshot feeds both classifiers; `_save` uses `write_private_file` (#67)
- ~~B6~~ ✓ done 2026-09-18. `frigate/fork/updates.py` fetches outside the lock behind a `_refreshing` flag and serves the stale value meanwhile (#67)
- ~~B7~~ ✓ done 2026-09-18. `RestartLog` prunes dump keys past the repeat window and trims history in one write (#67)
- ~~B10~~ ✓ done 2026-09-18. An expired hwaccel switch restarts detect only (`reset_capture_thread(cause="hwaccel retry")`); recording keeps running (#76)
- ~~B11~~ ✓ done 2026-09-18. Update check backs off after any fetch error; bulk event delete removes rows before media; the share-link cap is counted and inserted under one lock, because `SqliteQueueDatabase` rejects `atomic()` (#76)

#### B8 — Make the logging and exception rules enforceable `[fork]`
- **Where:** `pyproject.toml:21` (ignores `G004` while selecting `G`; the stale `ASYNC230` ignore went with G15); f-string log calls in `frigate/video/ffmpeg.py` (18), `hwaccel_fallback.py` (3), `restart_log.py` (1), none left in `camera_outage.py`, `fork_share.py` or any file added since 09-17; silent swallow `frigate/genai/plugins/ollama.py:288-289`; one broad try around three probes `:322-333`
- **What's wrong:** `AGENTS.md` mandates lazy `%s` logging and logged, narrow excepts, but nothing enforces it and the fork's files mix both styles.
- **Fix:** Enable `G004` for fork-owned files (per-file ignores for upstream files so rebases stay clean) and convert the fork's sites; log at `ollama.py:289`; narrow the probe's try to the two network calls.
- **Effort:** S
- **Grade lift:** B+ → B+ (hygiene)

#### B9 — Give the fork's own routes response models `[fork]`
- **Where:** `frigate/api/fork_updates.py:31` (bare `JSONResponse`), `review_audio.py:87`, `stream_diagnostics.py:162`. Done since 09-17: all four JSON routes of `fork_share.py` (`defs/response/fork_share_response.py`)
- **What's wrong:** Three of the fork's routes still return raw dicts, so they are untyped in `docs/static/frigate-api.yaml` and in the generated client types that A5 introduced.
- **Fix:** Pydantic models in `frigate/api/defs/response/`, regenerate the spec and `api.gen.ts`, move the frontend callers to `useApi`.
- **Effort:** S
- **Grade lift:** B+ → B+ (stops B2 getting worse)

#### B2 — Declare `response_model` on the remaining 108 routes `[upstream]`, backlog
- **Where:** `frigate/api/**/*.py` (81 of 189 routes covered; `app.py` 30 routes with none, `media.py` 28, `camera.py` 12, `auth.py` 10, `chat.py` 6)
- **What's wrong:** More than half the API is untyped in the OpenAPI spec, which caps what A5's generated types can cover.
- **Fix:** Add pydantic response models, frontend-heaviest routes first.
- **Effort:** L
- **Grade lift:** B+ → A−

#### B4 — Declare indexes on models, not only in migrations `[upstream]`, backlog
- **Where:** `migrations/011`, `017`, `020`, `022`, `027`, `036` vs `frigate/models.py` (only `UserReviewStatus` has `Meta.indexes`, `:123-124`); `ShareLink` (`:167-175`) lacks the `expires_at` index that `migrations/036:50` creates and the pruning query (`frigate/events/share_links.py:21`) filters on
- **What's wrong:** Models under-document the real schema; the fork repeated the pattern one migration after it was written up.
- **Fix:** Matching `class Meta: indexes`, starting with `ShareLink`; migrations stay authoritative.
- **Effort:** S
- **Grade lift:** B+ → B+ (hygiene)

---

## C — Frontend Quality — B−

Holds at B− (up from C+ on 09-17). New fork code is strong: module stores with
`useSyncExternalStore` instead of prop drilling, pure logic split out and
unit-tested file by file, all storage behind `lib/fork/local-storage.ts`,
every listener and observer cleaned up, `ErrorState` and `Skeleton` on new
views, deliberate a11y (`role="slider"` with `aria-valuenow` on the timeline
handle, keyboard map in `utils/timelineKeys.ts`), and no hard-coded strings in
new components. Floating promises are errors and the type ratchet holds. It
stops at B− because the app-level debt is untouched after 422 commits:
`handleSaveAll` is 296 untested inline lines (`pages/Settings.tsx:910-1205`), 38 files exceed
800 lines, 107 `exhaustive-deps` suppressions remain, and the 10 defects the
09-17 audit found in fork code are all still open (C20 to C29; only half of
C27 moved). The share UI merged since is B-level work (typed API, loading,
error and empty states, plural i18n keys, unit and e2e tests) that shipped
with four small defects of its own (C30, C31). The jsx-a11y findings were
already at zero (cleared by 8e154085e on 2026-09-12); C9 turned the rules
into errors so they stay there.

- ~~C1~~ ✓ done 2026-09-10. `components/fork/RouteErrorBoundary.tsx`, chunk-load recovery
- ~~C2~~ ✓ done 2026-09-10. jsx-a11y lint, 42 role/tabIndex sites, 27 real buttons (residue tracked as C9)
- ~~C5~~ ✓ done 2026-09-10. SWR read-error toasts + `ErrorState`
- ~~C9~~ ✓ done 2026-09-17. All 32 enabled jsx-a11y rules plus `control-has-associated-label` are errors (`web/eslint.config.js`); 0 sites needed fixing because 8e154085e had cleared the 83 findings. Seven per-site suppressions remain: `media-has-caption` on the four camera `<video>` players and the share page's (`ShareClipPage.tsx:90`), the paste target in `ImageEntry.tsx:137`, the click map in `LiveBirdseyeView.tsx:286`. `web/src/components/ui/**` is outside eslint
- ~~C8~~ ✓ done 2026-09-10. Sandbox gated to dev
- ~~C10~~ ✓ done 2026-09-11. TypeScript hatch ratchet, fork-strict typecheck
- ~~C11~~ ✓ done 2026-09-11. Floating and misused promises are errors (269 → 0)
- ~~C12~~ ✓ done 2026-09-11. SonarCloud findings in fork web code (3 props types still not `Readonly`: `EventSummaryHeader.tsx:37`, `updates/ReleaseNotesDialog.tsx:38,78`)
- ~~C20~~ ✓ done 2026-09-18. `getId` for `useBulkSelection` is a module-level function, so Explore thumbnails skip renders again; a `renderHook` test pins the identity (#75)
- ~~C30~~ ✓ done 2026-09-18. The share dialog only lists links on open and creates behind a button; a failure (429 at the cap included) stays in the dialog, stale results are dropped, a failed revoke revalidates (#75)
- ~~C31~~ ✓ done 2026-09-18. Public share page: error state with Retry, video `onError`, status roles, shared camera-name format; the share-path regex is anchored (#75)
- C13 to C19: see `FORK.md`

#### C3 — Extract the Settings "Save All" transaction into a tested module `[fork]`
- **Where:** `web/src/pages/Settings.tsx:910-1205` (`handleSaveAll`, about 296 lines: per-section payloads, detector/model PUT, go2rtc diff and delete at `:809-840`, restart flags, `Promise.allSettled`, `mutate("config")`); duplicate go2rtc credential diff in `web/src/lib/fork/settings-diff.ts:110-134`
- **What's wrong:** The riskiest UI logic is inline and untested, and the review dialog computes the go2rtc diff with a second copy of the logic, so the dialog can disagree with what Save All does.
- **Fix:** `web/src/lib/fork/settings-save.ts` with vitest for ordering, partial failure and restart-required; both `Settings.tsx` and `settings-diff.ts` call one go2rtc diff function.
- **Effort:** M
- **Grade lift:** B− → B− (risk reduction on the most dangerous screen)

#### C21 — Inbox store: tabs overwrite each other, a write per message, fragile thumbnails `[fork]`
- **Where:** `web/src/lib/fork/inbox-store.ts:116-119,140,244`; `web/src/hooks/fork/use-inbox.ts`; `web/src/components/fork/InboxBell.tsx:228`
- **What's wrong:** `reloadInboxFromStorage` is exported and called only from its test, so two tabs blind-write the same key and wipe each other's read state. Every `reviews` WebSocket message JSON-stringifies up to 200 items synchronously. The thumbnail URL uses an unanchored `.replace("/media/frigate/", "")` with no `onError`.
- **Fix:** A `storage` event listener that calls `reloadInboxFromStorage`; debounce persistence (about 1 s trailing) while keeping `emit()` synchronous; anchored regex plus an `onError` fallback to `/api/review/{id}/thumbnail.webp`.
- **Effort:** S
- **Grade lift:** B− → B−

#### C22 — Non-English users get a 404 per fork namespace load, and one string skips `t()` `[fork]`
- **Where:** `web/public/locales/*/` (58 locale folders, only `en/fork.json` exists); `web/src/utils/i18n.ts:33-37`; `web/src/components/fork/bulk/BulkActionBar.tsx:96` (`"Unknown error"`)
- **What's wrong:** `i18next-http-backend` requests `locales/{lng}/fork.json`, gets a 404, then falls back to English (the 09-18 change to `i18n.ts` only roots `loadPath` at the base URL for the share page). Every fork surface is English-only and translators have no target file.
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

#### C27 — Share-view copy falls back to `window.prompt` `[fork]`
- **Where:** `web/src/components/navigation/ShareViewButton.tsx:10-18` (clipboard failure falls back to `window.prompt`; copied state never resets). Done 2026-09-18 with E16: `role="img"` on both QR containers, with tests
- **What's wrong:** `window.prompt` is blocked in sandboxed iframes and unusable with assistive tech.
- **Fix:** An inline read-only input with a `role="status"` message and a timed reset.
- **Effort:** S
- **Grade lift:** B− → B−

#### C28 — Overlay history can swallow a real back press `[fork]`
- **Where:** `web/src/lib/fork/overlay-history.ts:33-42,71-82`
- **What's wrong:** `pendingSelfPops` is incremented before an asynchronous `history.back()`; a user back press that lands first decrements the counter and closes nothing.
- **Fix:** Tag the expected entry (compare `currentState().overlayId`) instead of counting; extend `overlay-history.test.ts` with the interleaved case.
- **Effort:** S
- **Grade lift:** B− → B−

#### C29 — The new System AI/model views need a shared formatter and memoized series `[fork]`
- **Where:** `web/src/views/system/AIModelMetrics.tsx:82-91` (335 lines, four copies of a disclosure pattern), `AIModelGraphs.tsx:31,128-131,140-165,216,231`, `ServerPressure.tsx:9-12`, `StabilityIncidents.tsx:64,88-91`; `web/src/hooks/use-hour-rollover.ts` (no test)
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
- **Where:** `pages/Settings.tsx` (2,360), `components/overlay/detail/SearchDetailDialog.tsx` (1,955), `views/live/LiveCameraView.tsx` (1,848), `views/motion-search/MotionSearchView.tsx` (1,646), `pages/Exports.tsx` (1,577); 38 files over 800 lines, 105 over 400; in fork code `CommandPalette.tsx` (475), `SettingsNav.tsx` (442), `CameraHealthView.tsx` (424)
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

Holds at B. On `next` now: 1,410 backend tests in 130 files (up 67 in a day,
all from the closed items), vitest up by the share suites from 508 tests,
54 e2e specs (25 under `specs/fork/`) in three shards, and by static count
80 tests for the fork's scripts and 79 for the audio trial. The share feature alone has about 46 tests
across API, migration, cleanup and nginx config.
Fixtures are validated against the OpenAPI spec in `globalSetup` (D9), every
fork backend module is tested including the migration's rollback, and
SonarCloud gates new code at 80% (83.5% now; 50.2% overall with browser
coverage merged). Not B+: the tracking pipeline is still untested (D4), no
visual regression or tablet project (D6, D3), unit line coverage is 13.4%
(web) and 40% (Python) with no floor of their own, two flaky e2e tests
pass on the CI retry, and a third flaky test surfaced during the merges
(D51).

- ~~D1~~ ✓ done 2026-09-10. `web/__test__/test-setup.ts`, CI step
- ~~D2~~ ✓ done 2026-09-11. e2e for Settings save, camera wizard, zone editing, motion search
- ~~D5~~ ✓ done 2026-09-10. vitest v8 coverage in CI
- ~~D8~~ ✓ done 2026-09-10. `coverage run -m unittest` in `fork/scripts/py-checks.sh:25-38`, XML uploaded, fed to Sonar
- ~~D9~~ ✓ done 2026-09-11. `web/e2e/scripts/validate-fixtures.mjs` (Ajv against 200 schemas)
- ~~D10~~ ✓ done 2026-09-11. Software-decoding fallback (`frigate/video/hwaccel_fallback.py`, 20 tests; B5 fixed 2026-09-18, residue → B10)
- ~~D11~~ ✓ done 2026-09-11. Restart log with reasons (`frigate/video/restart_log.py`, 13 tests)
- ~~D12~~ ✓ done 2026-09-11. No doubled punctuation (`restart_log.py:158`)
- ~~D13~~ ✓ done 2026-09-11. Circular-progress timings
- ~~D14~~ ✓ done 2026-09-11. Camera Health thresholds, 7-day remembered fallback
- ~~D15~~ ✓ done 2026-09-11. Frame-rate chart seeded from `/stats/history`
- ~~D16~~ ✓ done 2026-09-11. Mock `/api/stats/history`
- ~~D19~~ ✓ done 2026-09-11. Layout-only tests selected by tag (`grepInvert`; residue → D50)
- ~~D51~~ ✓ done 2026-09-18. The model cache is trusted only once its verification is 2 s newer than every file (racy-timestamp rule); the flaky test forces its timestamp change, two new tests (#73)
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
- **Where:** `web/e2e/specs/fork/camera-wizard.spec.ts:136`, `motion-search.spec.ts:75,121`, `settings-save.spec.ts:14,57`, `zone-editing.spec.ts:173`
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

Holds at B+, one small PR from A−. The two blockers named on 09-17 are gone:
the public share feature now has its operational half (E15, E16). A review
of that code checked the places where such features usually fail and found
them right: 192-bit tokens validated by regex before the lookup, revoke
scoped to the creator (404 for anyone else) or an admin, the list scoped to
the caller, the clip slot released on every path including cancellation, the
kill switch read once at import and covering create and both public routes,
tokens masked in the access log and absent from Python logs, non-GET methods
routed to the authenticated location. It is not A− yet because fork code
still carries an open CodeQL alert with no guard in the code (E17), the
`ffprobe` argument half of E18 is open, the review found three low-severity
gaps in the share path's operations (E20 to E22), there is no `SECURITY.md`,
and CSP is report-only.

- ~~E1~~ ✓ done 2026-09-10. `security_headers.conf`, HSTS, CSP report-only
- ~~E2~~ ✓ done 2026-09-10. One auth gate per route, startup assertion + test
- ~~E3~~ ✓ done 2026-09-10. `safe_join` in `preview_thumbnail`
- ~~E4~~ ✓ done 2026-09-10. CodeQL triage: 29 dismissed with written comments, 9 fixed (residue → E17, E18, E19)
- ~~E5~~ ✓ done 2026-09-11. Shipped dependency advisories patched; 145 remaining alerts are in `docs/` (125), unbuilt TensorRT manifests (16), dev-only vitest (2) and the build stage (2 → F7)
- ~~E6~~ ✓ done 2026-09-18. The CSP in `docker/main/rootfs/usr/local/nginx/conf/security_headers.conf` is enforced, same directives; `E2E_CSP=1` serves that policy in preview and `web/e2e/specs/fork/csp.spec.ts` fails on any violation (0 across 6 routes × 2 layouts). Not covered: the go2rtc WebRTC page and live playback, which need a real backend
- ~~E15~~ ✓ done 2026-09-18. clip window clamped to 600 s, `BoundedSemaphore(4)` and nginx `limit_req` on the public route, tokens masked in the access log, camera mismatch is a 404 (#68)
- ~~E16~~ ✓ done 2026-09-18. `GET /fork/share`, `DELETE /fork/share/{token}`, 50-link cap, links removed with their user, `FRIGATE_FORK_CLIP_SHARING=false` switch, `ActiveShareLinks.tsx` (#68)
- ~~E20~~ ✓ done 2026-09-18. Share rate and connection limits are keyed on the token, with a looser per-address pair (#74)
- ~~E21~~ ✓ done 2026-09-18. `error_log ... crit` in both share locations; residue: the `/share/<token>` page under `location /` still logs at `warn` (#74)
- ~~E22~~ ✓ done 2026-09-18. `_SlotStream.release` unlinks the clip playlist when a share client leaves before the body starts (#76)
- E7 to E14: see `FORK.md`

#### E17 — Close the open code-scanning findings `[fork]`
- **Where:** `actions/missing-workflow-permissions` alerts #35, #36, #37 (`ci.yml`) and #38 (`release.yml`); SonarCloud reports 10 open vulnerabilities on `next`. Done 2026-09-18 (#74): `setPath` and `mergeInto` in `web/src/lib/fork/zone-rename.ts` skip `__proto__`, `constructor` and `prototype`, with tests; confirm CodeQL #51 closed on its next run
- **What's wrong:** The Security tab is only a signal while it is at zero.
- **Fix:** Re-dismiss the four workflow alerts with the E4 reasoning (owner, or on request); triage the 10 Sonar vulnerabilities (fix or mark with a reason) and record them in E19's file.
- **Effort:** S
- **Grade lift:** B+ → A− (with the rest of E18)

#### E18 — Harden the `ffprobe` path argument `[fork, upstreamable]`
- **Where:** `frigate/util/services.py:1023` (`ffprobe_stream` passes the user-supplied path as a bare positional argument)
- **What's wrong:** A path starting with `-` is parsed as an ffprobe option on the admin-only route. The other half of this item, validating the share token in the browser before requesting, shipped on 2026-09-18 (`lib/fork/share-path.ts:22-26`, called at `ShareClipPage.tsx:35`, tested).
- **Fix:** Pass `-i` before the path (or reject a leading `-`) with a test.
- **Effort:** S
- **Grade lift:** B+ → B+

#### E19 — Keep the triage record in the repo `[fork]`
- **Where:** dismissal reasons live only in GitHub alert comments and one `FORK.md` row; no `SECURITY.md`
- **What's wrong:** The reasoning is lost if alerts are re-raised (it already happened to 4) or the repo moves, and reporters have no contact path.
- **Fix:** `fork/SECURITY-TRIAGE.md` (alert, rule, verdict, reason) and a short `SECURITY.md`.
- **Effort:** S
- **Grade lift:** B+ → B+

## F — Dependencies & Tech Currency — B−

Holds at B−; nothing in this category moved since 09-17. Security patching is good, react-router 7 was taken (PR #49,
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
- **Where:** `docker/main/requirements.txt:3`, `docker/main/requirements.lock:17` (`setuptools == 77.0.3`, fork-introduced; high advisory below 78.1.1); Dependabot PR #50 (to 83.0.0) still open and unmerged; it is the only open high advisory outside `docs/`
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

Back to B−, a weak one. The backend half of the 09-17 downgrade is fixed:
`/events/explore` is one windowed query instead of 2N+1 (G13), both bulk
deletes run in chunks of 500 (G14: 3,600 statements became 9), and the
preview frame scan left the event loop (G15), each with a query-count test.
The earlier wins hold (G4, G6, G3, G7). The frontend half did not move at
all: eager JS is 393 kB gzip against a budget raised to 412,650 to fit it,
no list is virtualized, 25 of 35 `<img>` are not lazy, and nothing measures
real interaction latency. On the server, `review_summary` still full-scans
on every poll and there is zero ETag/304 handling in `frigate/api/`.

- ~~G1~~ ✓ done 2026-09-10. Explicit icon map, lazy settings menus
- ~~G2~~ ✓ done 2026-09-10. SWR global policy
- ~~G3~~ ✓ done 2026-09-10. Sync handlers are `def`; `asyncio.to_thread`; ruff `ASYNC` (`delete_camera` moved behind a thread since)
- ~~G4~~ ✓ done 2026-09-10. SQL ORDER BY/LIMIT, bounded vector candidates
- ~~G5~~ ✓ done 2026-09-10. Lazy players, `manualChunks`, memoized cards (partly undone → C20)
- ~~G6~~ ✓ done 2026-09-10. `frigate/record/cache_tracker.py`
- ~~G7~~ ✓ done 2026-09-10. `web/scripts/fork/bundle-budget.mjs` in CI and `make check`
- ~~G8~~ ✓ done 2026-09-18. `@rjsf/validator-ajv8` is imported dynamically in `web/src/components/config-form/ConfigForm.tsx`, so the validator streams beside the settings chunk instead of inside it (882 kB → 635 kB raw); the form renders after it resolves
- ~~G13~~ ✓ done 2026-09-18. `explore_recent_events` is one windowed query with an explicit column list: 45 SELECTs became 1 for 22 labels (#69)
- ~~G14~~ ✓ done 2026-09-18. `frigate/api/fork_bulk.py` fetches and deletes in chunks of 500; 1,200 event ids went from 3,600 statements to 9, 1,100 reviews from 1,104 to 23; camera access is checked before anything is deleted (#69)
- ~~G15~~ ✓ done 2026-09-18. `select_preview_frames` runs in a thread and matches the whole camera name (#69)

#### G17 — Eager bundle grew 29% and the budget followed it `[fork]`
- **Where:** `fork/bundle-budget.json` (`eagerGzipBytes` 412,650; measured 393 kB, was 305 kB after G1/G5); `fork/ROUTER7-BUNDLE-BUDGET.md`; shell-level fork imports in `web/src/App.tsx` and the navigation (command palette, inbox, update notices, appearance)
- **What's wrong:** The budget is measured + 5%, so each raise legitimizes the growth. Part is react-router 7, but fork features that open on demand (palette, a static import at `App.tsx:28`, and the inbox panel) load for every user at startup. `ReleaseNotesDialog` is already lazy (`UpdateNotices.tsx:32`), and `share-path.ts` was split out so the shell does not pull in the QR encoder.
- **Fix:** Run the visualizer on the eager graph; `React.lazy` the palette body and inbox panel behind their triggers, and confirm `lib/fork/qr` (imported by `ShareClipButton`) only rides lazy chunks; then lower the budget to the new measurement and require a written reason in the PR for any raise.
- **Effort:** M
- **Grade lift:** B− → B

#### G9 — Virtualize the card grids and lazy-load images `[fork, upstreamable]`
- **Where:** `web/src/views/search/SearchView.tsx`, `views/events/EventView.tsx`, `views/recording/RecordingView.tsx` (no virtualization library in `package.json` or anywhere in `src`); 25 of 35 `<img>` lack `loading="lazy"`
- **What's wrong:** Long Review/Explore sessions grow the DOM and image memory without bound.
- **Landed 2026-09-18 (image half):** `decoding="async"` on the scrolling
  thumbnails, plus `loading="lazy"` on those that did not already defer
  (`web/src/components/card/{SearchThumbnail,ReviewCard,ClassificationCard,ExportCard}.tsx`,
  `web/src/views/explore/ExploreView.tsx`).
- **Fix (open):** Add `virtua` (about 3 kB) for the three grids behind a flag.
- **Effort:** M (image half done; virtualization remains)
- **Grade lift:** B− → B

#### G10 — Immutable, precompressed static assets `[upstream]`
- **Where:** `docker/main/rootfs/usr/local/nginx/conf/nginx.conf:398-403` (`/assets/`: `expires 1y` + `Cache-Control "public"`, no `immutable`); `:66,141` (gzip on the fly, no `gzip_static`)
- **What's wrong:** Reloads revalidate every hashed chunk; nginx recompresses the same files per request. Two lines of config, open since the first audit.
- **Fix:** `Cache-Control: public, max-age=31536000, immutable` for `/assets/`; emit `.gz` at build and enable `gzip_static`.
- **Effort:** S
- **Grade lift:** B− → B− (repeat-visit latency, server CPU)

#### G11 — HTTP caching for summary endpoints `[upstream]`
- **Where:** `frigate/api/review.py:201` (`review_summary`), `frigate/api/record.py:62,123`; zero `ETag`/`304` handling in `frigate/api/`
- **What's wrong:** Summaries are recomputed and re-sent on every poll and focus even when nothing changed.
- **Fix:** An ETag from the newest relevant row timestamp with a 304 path; measure in the demo stack first.
- **Effort:** M
- **Grade lift:** B− → B

#### G16 — `review_summary` filters cannot use an index `[upstream]`, backlog
- **Where:** `frigate/api/review.py:238-251` (`data["objects"].cast("text") % '*"label"*'`, OR-ed per label); same pattern at `:93-94,103,627`
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

Holds at C+, a strong one. The entry points are now right: the root
`README.md` opens with what the fork is and where its images are (H6), and
`AGENTS.md` describes the real workflow (H7); both were checked against the
`Makefile`, `promote.sh` and the workflows and match. `FORK.md` remains a
complete ledger. The rest still loses ground to the pace of work:
`fork/PLAN.md` and `PLAN2.md` carry statuses from 2026-09-11, `FORK.md`'s own
rules describe a rebase model the fork does not use, the rc2 base survives in
three files, `FORK.md` grew 15% in a day to 145 KB with every row appended at
the end (which is also a tooling cost, I35), nothing guards this report
against drift, and H3, H4 and H5 are untouched.

- ~~H1~~ ✓ done 2026-09-10
- ~~H2~~ ✓ done 2026-09-10 (its gate list is stale again → H7)
- ~~H6~~ ✓ done 2026-09-17. Fork block at the top of `README.md`: what the fork is, ledger, Releases, images, branch model, where upstream lives
- ~~H7~~ ✓ done 2026-09-17. "Fork workflow" section in `AGENTS.md` (worktrees, `next`, `make promote`, ledger IDs, gates); `CONTRIBUTING.md` points at it and `make check`

#### H8 — Reconcile the plans and the base version `[fork]`
- **Where:** `fork/PLAN.md:13` (says I12, means I13), `:88` ("In progress on `polish2`", which `:14` says is gone), `:95` (4b unticked); `fork/PLAN2.md:9,482` (status dated 09-11, PR #29 "in review", "Dependencies: Not started"); `FORK.md:10-13` ("rebased onto `upstream/dev`", "One report item = one commit"); rc2 base in `fork/demo/Dockerfile:2,4`, `fork/demo/README.md:20`, `fork/README.md:29` while `Makefile:64`, `fork/Dockerfile.test:4` and `fork-checks.yml` use 0.18.0. Fixed since 09-17: `FORK.md:42`, `fork/SONAR-CI.md:12`, the sync workflow's base
- **What's wrong:** Statements that contradict the ledger, and the demo runs on a different base than the tests. The base is hard-coded in five places.
- **Fix:** Archive finished plan sections and keep one current queue; reword `FORK.md`'s rules to the actual practice; one `fork/BASE_VERSION` file read by the Makefile, both Dockerfiles and the workflows.
- **Effort:** S
- **Grade lift:** C+ → C+

#### H9 — Keep this report honest automatically, and index `fork/` `[fork]`
- **Where:** `fork/GRADE-REPORT.md` vs `FORK.md` (no test ties a ledger ID marked done to an open heading here); `fork/SONAR-*.md` (12 files, about 1,600 lines) and 5 CSVs at the top of `fork/`; `fork/README.md` (115 lines; omits `make demo-audit`, `fork/monitoring`, `fork/benchmarks`, `Dockerfile.rootless-test` and about half of the 26 scripts); `FORK.md` (145 KB, 201 unsorted rows, cells up to 2,523 characters)
- **What's wrong:** The report only stays true if someone remembers to edit it, and the working folder is hard to navigate.
- **Fix:** A test next to `fork/scripts/test_release_notes.py` that fails when an audit item marked done in `FORK.md` is still an open heading here; move the Sonar write-ups to `fork/archive/sonar/` keeping `SONAR-CI.md`; extend `fork/README.md`; the ledger's shape is I35's job.
- **Effort:** M
- **Grade lift:** C+ → B−

#### H3 — Frontend, e2e and patches READMEs `[fork]`
- **Where:** `web/README.md` (a 25-line stub for 157k lines of TypeScript), no `web/e2e/README.md`, no `web/patches/README.md`
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
hash-locked dev dependencies, a required "Checks passed" status on `next` and
now on `main` (I29), releases with notes generated from commits, ROCm images,
and ratchets for types and bundle size. The Sonar gate, red on 5 of 12 pushes
before I28, has been green on 6 of 7 since (the seventh was cancelled, I36).
It does not reach B+ for two reasons. The automation still fails quietly: the
upstream-sync bot has failed every day since 2026-09-13 for a secret only the
owner can create, the Sonar token expires on 2026-10-11, pre-commit and the
mypy ratchet have not moved, and 79 remote branches have piled up. And
landing six PRs on 09-17/18 showed that the process itself is serial: every
PR appends to the same two ledger files, so each merge puts every other open
PR into conflict, and the up-to-date rule then costs a rebase and a 12-minute
run per PR, one after another (I35).

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
- ~~I29~~ ✓ done 2026-09-17. Ruleset "main: require quality checks" (id 23612078): `Checks passed` is a required status on `refs/heads/main`. `make promote` pushes a commit that already ran Fork - Checks on `next`, so it still works; a direct push of an unchecked commit is rejected
- ~~I32~~ ✓ done 2026-09-17. `check.sh` warns when HEAD is more than 20 commits behind `origin/next`; `.codex-output/` and `fork/demo/screenshots/compare/` ignored
- ~~I35~~ ✓ done 2026-09-18. New ledger rows are files under `fork/ledger/`, checked by `fork/scripts/ledger.py`; the up-to-date rule on `next` was switched off the same day (owner decision), `Checks passed` stays required (#73)
- ~~I36~~ ✓ done 2026-09-18. Only pull request runs are cancelled by a newer push; every merge on `next` gets a finished check (#73)
- ~~I37~~ ✓ done 2026-09-18. `ci-changes.sh` covers the gate scripts, `check.sh` asks the remote where `next` is, the Sonar expiry check probes the token after the date (#73)
- I15 to I26: see `FORK.md` (I16, I17 unused)

#### I27 — Give the upstream-sync bot its token `[fork]`
- **Where:** repository secrets (only `SONAR_TOKEN` exists; `FORK_SYNC_TOKEN`, which I18 added support for, was never created); `.github/workflows/fork-upstream-sync.yml`; issue #71 (its predecessor #61 was closed on 2026-09-18 while the runs were still failing, and the bot opened #71 eleven hours later)
- **What's wrong:** Every scheduled run since 2026-09-13 fails with "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission". `dev` has been frozen at 2026-09-06 and upstream is 186 commits ahead; conflicts pile up unseen, which is what I6 existed to prevent.
- **Fix:** Owner creates a fine-grained token (contents + workflows write) as `FORK_SYNC_TOKEN`. In the workflow, fail in the first step with a clear message when the secret is empty.
- **Update 2026-09-17:** The workflow part shipped: the run stops in its first step when the secret is empty and names the token to create, the "Upstream sync failed" issue carries the same steps, and the new-tag base is `v0.18.0`. Still open for the owner: create the fine-grained token (Contents and Workflows read and write on `jtn0123/frigate`) and save it as `FORK_SYNC_TOKEN`; steps in `fork/README.md`, "Owner setup".
- **Update 2026-09-18:** Unchanged. The last 5 scheduled runs failed in the first step with the clear message, the latest today at 12:14Z.
- **Effort:** S
- **Grade lift:** B → B+ (with I35)

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
- **Where:** 79 remote branches (45 on 09-17), 48 of them already merged into `origin/next`; `deleteBranchOnMerge` is off; 51 local worktrees, 2 prunable
- **What's wrong:** Finished `section/*` and agent branches accumulate and hide the live ones.
- **Fix:** Enable "automatically delete head branches"; delete merged remotes once; `git worktree prune`.
- **Effort:** S
- **Grade lift:** B → B

#### I3 — Continue the mypy ratchet `[upstream]`
- **Landed 2026-09-18 (first wave):** the 29 modules inside those packages that
  already pass the strict flags are checked per module in `frigate/mypy.ini`, so
  they cannot drift back. `frigate.util.media` is not among them: it does not
  type-check under the test image's peewee stubs, and the reason is recorded in
  the config. The package-wide waves below are still open.
- **Where:** `frigate/mypy.ini:28-55` (`ignore_errors = true` still covers the rest of `api`, `config`, `detectors`, `embeddings`, `ptz`, `util`, `video`, tests, `whisper_online`)
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
| ~~UI10~~ | Bulk actions in Explore + undo for mark-reviewed | M | ✓ done (open defect → C20) |
| ~~UI11~~ | Share a clip: expiring link + QR | M | ✓ done |
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
| ~~UI42~~ | Update notices and What's new from the fork's releases | M | ✓ done |
