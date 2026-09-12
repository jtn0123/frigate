# Fork work plan 2 — PR blocks after PLAN.md

`fork/PLAN.md` comes first. This file holds the items the owner selected on
2026-09-10 that are **not** in PLAN.md's queue, grouped into PR-sized blocks and
ordered by impact, most to least. Item IDs and full descriptions live in
`fork/GRADE-REPORT.md`; this file adds the grouping, order, and acceptance
criteria.

## Track status (2026-09-11)

Owner asked for debugging, then type safety, then dependencies, ahead of
PLAN.md step 9. Work is on `section/debug`.

| Track | Status |
|---|---|
| 1. Debugging | D12, D13, I12 committed. Demo QA logged below. No high-severity runtime bugs found to fix without an owner call. |
| 2. Type safety | Not started. Next: PR-02 type-guardrails, then PR-04, PR-01, PR-14. |
| 3. Dependencies | Not started. Wait for the debug PR. |

## Bugs found

Logged from the I7 demo stack at `https://127.0.0.1:8971` on 2026-09-11
(desktop, then iPhone 14 viewport). Walked Live, Review, Explore (including a
tracked-object detail), Exports, Settings, System → Health, the command
palette, and the inbox. Overlay at the time was an older polish2 UI build
(`0.18.0-c69ec86b1`); behaviour below is still from this fork.

### Fixed in this branch

- **D12 (high, logs):** repeat ffmpeg-exit warnings doubled a trailing period
  when ffmpeg's message already ended in ".". Test then fix.
- **D13 (build):** Tailwind ambiguous `delay-[var(--delay)]` /
  `duration-[var(--transition-length)]` on the circular progress label.
- **I12 (CI):** actionlint SC2016 on markdown backticks in
  `fork-upstream-sync.yml` issue-body printf strings.

### Needs an owner call (not fixing yet)

- **Nameless account/menu control.** Every page has a sidebar (desktop) or
  top-bar (phone) `button` with `expanded=false` and no accessible name, next
  to the command palette and inbox. Likely the user menu. Icon-only may be
  intentional; C9 would catch it later.
- **Two "Labels" filters on Explore.** After "Explore more Person objects",
  the toolbar has two `Labels` buttons (`e17` and `e20` in the a11y tree).
  Could be a duplicate control or a Sort/Labels mislabel. Ask before changing.
- **Review timeline buttons have no names.** Dozens of unnamed buttons on
  `/review` (the hour ticks / scrubber). Covered by C9; not a crash.

### Not a product bug (harness / a11y snapshot)

- Overlay **Close** and **Escape** did not dismiss the command palette or
  inbox in agent-browser; choosing a palette item (Live) did. Existing e2e
  covers close. Treat as harness unless a Playwright spec fails.
- Radix scroll-area CSS (`[data-radix-scroll-area-viewport]{scrollbar-width…}`)
  shows up in the a11y snapshot's root name on Live, but
  `document.body.innerText` does not include it. Not visible to users.
- Live PNG screenshots hung in this harness (video tiles). Snapshots were
  used instead.

No crashes, wrong data, dead primary buttons, or stray error toasts on the
walk. The C5 Explore-detail 404 toast was already fixed on `main`.

## When and how

- Start a block only when PLAN.md's queue has reached step 9 (closing), or
  earlier if the owner says so. A block that touches files a PLAN.md section is
  still changing waits for that section (noted per block).
- One block = one PR: branch `pr/<nn>-<slug>` from `main`,
  `gh pr create --repo jtn0123/frigate --base main`, one commit per item ID
  inside it, "Fork - Checks" green, then merge. Blocks marked "series" are
  several PRs in the listed order.
- All of PLAN.md's hard rules, gates, safety setup and environment gotchas
  apply unchanged (own repos only, never the live server, no secrets, flags for
  fork UI, `fork` i18n namespace, ledger row per item, never loosen a test or
  lint rule, at most two agents at once).
- Conflict risk is judged from upstream churn over the last 180 days (commits
  on `upstream/dev` touching the file): `Settings.tsx` 21, `media.py` 14,
  `MotionSearchView.tsx` 12, `Events.tsx`/`EventView.tsx` 9,
  `SearchDetailDialog.tsx` 8, `LiveCameraView.tsx`/`event.py`/`review.py` 7,
  `ws.ts` 3, `SearchView.tsx`/`App.tsx` 1, `models.py` 0.

### What was selected, and what was left out

In this file: A2 A3 A4 A5 · B2 B4 · C4 C6 C7 C10 C11 · D4 D7 D9 · E6 · F4 F5 ·
G8 G9 G10 G11 G12 · H5 · I3 I8 I9 I10 I11 · UI18 UI20 UI21 UI23–UI28 UI29 (revised)
UI30–UI41.

Left out on purpose: D3 (owner excluded; still ships with A1 in PLAN.md), H4,
UI19 kiosk mode, UI22 morning digest. Everything already in PLAN.md's queue
(A1, C3, C9, D2, D6, D8, E4, E5, G7, H3, I5, I6, I7, UI5–UI17) stays there.

**UI29 revised.** 0.18 already has a calendar with activity markers
(recordings, alerts, detections) on Review and Explore
(`web/src/components/overlay/ReviewActivityCalendar.tsx`,
`components/filter/CalendarFilterButton.tsx`). The page that lacks date
selection is Exports (`types/export.ts` `ExportFilter` has only `cameras`), so
UI29 is now "date-range filter on Exports, reusing `CalendarFilterButton`, no
activity dots".

New IDs added to `fork/GRADE-REPORT.md` with this plan: **C11** (promise misuse)
and **D9** (e2e mocks validated against the API spec); with PR-13, **I10**
(local gates and worktrees) and **I11** (toolchain trial).

---

## Type safety: what clamping down buys

Measured on `polish` (now `main`) @ 41edb589c, 2026-09-10, without changing any code.

### Where it stands

| Layer | Today |
|---|---|
| TypeScript compile | `strict` + `noUnusedLocals/Parameters` + `noFallthroughCasesInSwitch`: **0 errors**, gates the build |
| Escape hatches | 23 explicit `any` (+25 `no-explicit-any` disables), 18 `@ts-expect-error`, 20 `as unknown as`, 0 `@ts-ignore` |
| API boundary | 212 of 228 `useSWR` calls carry a type, but it is an assertion against 2,187 hand-written lines in `web/src/types/`; nothing checks the real response |
| Lint | `tseslint.configs.recommended` (no type-aware rules) |
| Python config | 166 pydantic models validate config at startup |
| Python mypy | strict flags, but `ignore_errors = true` for `api`, `config`, `util`, `video`, `detectors`, `embeddings`, `ptz`, `test`; `http` leftover ignore removed (no module); `debug_replay` on |
| Python annotations | 70% of functions fully annotated; 147 `type: ignore`; 784 `Any` |
| API spec | 77 of 179 routes declare `response_model` |

### What each extra switch would surface

TypeScript flags (errors if turned on for all of `web/src`):

| Flag | Errors | Files | In fork dirs |
|---|---:|---:|---:|
| `noUncheckedIndexedAccess` | 652 | 124 | 1 |
| `noPropertyAccessFromIndexSignature` | 423 | 61 | 1 |
| `exactOptionalPropertyTypes` | 399 | 128 | 0 |
| `noImplicitReturns` | 47 | 37 | 0 |
| `noImplicitOverride` | 3 | 1 | 3 |

Type-aware lint rules (typescript-eslint, findings across `web/src`):

| Rule | Findings | Files | What it catches |
|---|---:|---:|---|
| `no-unnecessary-condition` | 1,495 | 220 | dead checks; noisy with loose upstream types |
| `no-unsafe-member-access` | 399 | 79 | reading fields off `any` |
| `no-unsafe-assignment` | 366 | 115 | `any` leaking into typed variables |
| `no-floating-promises` | 136 | 62 | promise errors silently dropped |
| `no-misused-promises` | 127 | 72 | async functions passed where a void callback is expected (e.g. `onClick`) |
| `no-unsafe-return` / `-argument` / `-call` | 48 / 43 / 27 | 22 / 27 / 12 | `any` crossing function boundaries |
| `switch-exhaustiveness-check` | 18 | 17 | a new enum value silently unhandled |

Unsafe-`any` hotspots: `pages/Explore.tsx` 45, `hooks/use-fullscreen.ts` 35,
`api/ws.ts` 32, `views/settings/TriggerView.tsx` 31, camera wizard steps 4 and
2 (29, 25), `components/player/WebRTCPlayer.tsx` 25, `pages/FaceLibrary.tsx` 25.
Promise-misuse hotspots: `views/settings/AuthenticationView.tsx` 10,
`components/card/ReviewCard.tsx` 9, wizard step 2 9, `pages/Events.tsx` 9.

mypy with every `ignore_errors` removed: **6,661 errors in 159 files**. 5,019
are in tests (3,817 `arg-type`, mostly mocks). Production code has **1,642**:
`api` 535 (event 108, media 85, app 60, classification 46, auth 38, review 29),
`detectors` 263, `util` 235, `ptz` 194, `embeddings` 151, `config` 116,
`video` 79, `data_processing` 68 (vendored whisper), `debug_replay` 1,
`http` 0. By kind: 580 missing annotations, 172 `assignment`, 170 `arg-type`,
162 `attr-defined`, 116 `index`, 110 `union-attr`, 55 `unreachable`.

### The impact, honestly

**What it buys this fork.**

1. **Rebases stop breaking the UI at runtime.** Upstream changes a response
   shape; today the UI compiles and fails in front of the user. With generated
   types (A5) and spec-checked mocks (D9), the next rebase fails `tsc` and CI
   instead. This is the single biggest benefit, because this fork lives on
   rebases.
2. **A real bug class goes away.** The 263 floating/misused promises are places
   where an error is swallowed or an async handler's rejection is unhandled
   (for example in `AuthenticationView` and `ReviewCard`). Fixing them removes
   silent failures users see as "the button did nothing".
3. **Refactors get safe.** C4/C6/C7 and every feature that touches a god
   component are far less risky when `any` is not flowing through them.
4. **Agents work better.** AI agents lean on compiler and linter feedback; a
   tighter type system catches their mistakes before review.
5. **Backend modules become checkable.** `http` (0 errors) and `debug_replay`
   (1) can be switched on today; `ptz` + `video` + `config` (389 production
   errors together) are the next realistic wave.

**What it costs.** Nearly every finding is in upstream files. Turning the
extra TypeScript flags or the noisy lint rules on globally means about 1,500
compile errors and ~2,000 lint findings across ~200 upstream files: a huge diff
that conflicts on every rebase, with little user-visible gain. So the right move
is **fork-scoped strictness + a ratchet**, not a global switch.

**Projected effect** (if blocks PR-01, PR-02, PR-04 and the first two mypy
waves land): A B− → B (API contract), C C+ → B− (with C9 from PLAN.md), I B →
B+ (mypy coverage roughly doubles in production code), and no new `any`,
hatch, or promise misuse can land unnoticed.

### Strategy

| Tier | Do | Why |
|---|---|---|
| 1 — high value, low conflict | Generated API types in new files (A5); spec-validated e2e mocks (D9); a second tsconfig that applies all five extra flags to fork directories only; type-aware lint on fork directories only; a ratchet script that fails CI if any count rises (C10); mypy on for `http` and `debug_replay` | All new files or config; nothing upstream conflicts with it |
| 2 — high value, medium conflict | Fix the 263 promise-misuse sites and set both rules to `error` (C11); response models for the ~30 routes the UI calls most (B2); mypy waves `ptz`+`video`, then `config`, then `util`, then `detectors`+`embeddings`, `api` last (I3) | Small hunks in upstream files; each wave is one PR so the ratchet holds |
| 3 — do not do globally | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` and `no-unnecessary-condition` across all of `web/src`; mypy on tests; typing peewee queries | ~1,500 compile errors and ~1,500 noisy findings in upstream files for little user-visible gain; tests are 3,817 mock `arg-type`s |

---

## PR blocks, most impact first

Each block lists items, scope, done-when, size, impact and conflict risk.
Blocks that need the demo stack wait for PLAN.md step 3b (I7).

### PR-01 · type-contract — A5, D9 — M
- **Scope:** `web/scripts/fork/gen-api-types.mjs` generating
  `web/src/types/fork/api.gen.ts` from `docs/static/frigate-api.yaml`
  (`openapi-typescript`, dev dependency); a CI check that the generated file is
  current; a typed `apiGet<Path>()` helper and `useApi<Path>()` SWR wrapper in
  `web/src/api/fork/`; migrate the `config`, `review`, `events` and `stats`
  keys used by fork code and the top five views. D9: validate every JSON
  fixture in `web/e2e/fixtures/` against the spec in the e2e setup, so mocks
  cannot drift.
- **Done when:** changing a response schema in the spec makes `tsc` fail at a
  migrated call site (prove it in the PR description); fixtures validate.
- **Impact:** A B− → B. **Conflict:** low (new files; one-line imports).

### PR-02 · type-guardrails — C10, I3 (first step) — S
- **Status (2026-09-11):** C10 and I3 step 1 on `section/type-guardrails`.
  Baselines in `fork/type-ratchet.json`: 23 `any`, 18
  `@ts-expect-error`, 25 `as unknown as`, 25 `no-explicit-any` disables;
  type-aware rule counts across `web/src` as of this commit (floating 137,
  misused 125, unnecessary-condition 1505). `debug_replay` mypy 1 → 0;
  `frigate.http` ignore was a leftover (no module).
- **Scope:** `web/tsconfig.fork-strict.json` (extends the base, adds the five
  extra flags, includes only `src/**/fork/**`, `src/fork/**`, `e2e/specs/fork/**`)
  run in "Web - Lint"; type-aware lint rules from the table above on the same
  paths; `web/scripts/fork/type-ratchet.mjs` with `fork/type-ratchet.json`
  baselines (escape hatches, and per-rule counts across all of `web/src`) that
  fails if any number rises and prints how to lower the baseline when it falls;
  fix the 3 `noImplicitOverride` sites in fork code; remove the `ignore_errors`
  blocks for `frigate.http` and `frigate.debug_replay` (fix the 1 error).
- **Done when:** CI enforces all of it; baselines committed.
- **Impact:** protects every later gain. **Conflict:** low.

### PR-03 · list-performance — G9 — M
- **Scope:** `@tanstack/react-virtual` behind flag `virtualGrids` for
  `views/search/SearchView.tsx`, `views/events/EventView.tsx`,
  `views/recording/RecordingView.tsx`; `loading="lazy" decoding="async"` on
  the 24 non-critical `<img>`. Wait for PLAN.md features2/features3 (UI10 and
  UI9 touch these views).
- **Done when:** a 2,000-item mocked Explore keeps DOM nodes roughly constant
  while scrolling (e2e asserts), keyboard focus and bulk selection still work.
- **Impact:** G B− → B. **Conflict:** low–medium (`SearchView` 1 upstream
  commit in 180 days, `EventView` 9).

### PR-04 · promise-safety — C11 — M
- **Status (2026-09-11):** C11 on `section/promise-safety`, merged onto main
  after #13 and #19. Both rules are `error` for all of `web/src`; 269
  findings to 0. Ratchet locked at floating 0 and misused 0. `wrapAsync`
  plus `void` for fire-and-forget. WebRTCPlayer awaits the peer connection
  before assigning `pcRef` (the old `if (!aPc)` checked the Promise object).
- **Scope:** fix the 136 `no-floating-promises` and 127 `no-misused-promises`
  findings (await with error handling, `void` only where fire-and-forget is
  intended and commented, wrap async handlers), then set both rules to `error`
  for all of `web/src`. Hotspots first: `AuthenticationView`, `ReviewCard`,
  wizard step 2, `Events.tsx`.
- **Done when:** both rules are errors with zero findings; failures that used
  to vanish now surface through the existing toasts.
- **Impact:** C C+ → B− (with C9); removes silent-failure bugs.
  **Conflict:** medium (many small hunks; one file per commit if needed).

### PR-05 · advisor-and-checklist — UI20, UI23 — M
- **Scope:** read-only rule panels, no backend. UI20 on the System page: detect
  resolution/fps higher than needed, no hwaccel, more than one connection per
  camera without restream, Birdseye on but unused, decoder restarts. UI23 in
  Settings: auth on, admin password changed from generated, HTTPS (needed for
  web push), notifications, retention set, detector not CPU. Every tip links to
  the setting and the docs. Flags `performanceAdvisor`, `setupChecklist`.
- **Done when:** vitest per rule; e2e with mocked config/stats that triggers
  each tip; dogfooded in the demo stack.
- **Impact:** highest user value in this file (would have flagged the Tapo
  decoder crashes). **Conflict:** low (new components, one mount point each).

### PR-06 · settings-load — G8 — M
- **Scope:** precompile the rjsf/ajv validators at build time (standalone
  code) or load `@rjsf/validator-ajv8` on first validation; keep behaviour.
  Wait for PLAN.md C3 (step 5a).
- **Done when:** `ConfigSectionTemplate` chunk drops well below 246 kB gzip
  (G7 budget shows it); Settings e2e (D2) passes unchanged.
- **Impact:** Settings opens much faster. **Conflict:** medium
  (`Settings.tsx` is the most-churned file; keep the hunk tiny).

### PR-07 · pipeline-tests — D4 — M
- **Scope:** new test files only: synthetic detections through
  `frigate/track/object_processing.py` asserting events, zones and
  review segments; dispatcher topic routing.
- **Done when:** runs in the thin image; D8 coverage shows the pipeline
  modules covered.
- **Impact:** D B− → B. **Conflict:** none (new files).

### PR-08 · api-response-models — B2 (top routes), B4 — M
- **Scope:** pydantic `response_model` for the ~30 routes the UI calls most
  (review, events, config, stats, recordings summary, exports); matching
  `class Meta: indexes` in `frigate/models.py` (B4). Regenerate the spec and
  A5 types in the same PR.
- **Done when:** spec check passes; A5 types for those routes are no longer
  `unknown`; backend tests green.
- **Impact:** B B → B+, and extends A5. **Conflict:** medium (`media.py` 14,
  `event.py` 7); decorator-argument hunks only.

### PR-09 · review-speed — UI21, UI27, UI32 — M
- **Scope:** triage keys (j/k, space, r mark reviewed, e export, `?` cheat
  sheet); swipe-to-review on mobile cards; undo toast for deleting clips and
  exports (reuse UI10's undo pattern). Flags `triageKeys`, `swipeReview`,
  `undoDestructive`.
- **Done when:** e2e desktop + `@mobile`; keyboard spec extended; undo restores
  within the toast window. **Impact:** daily review much faster.
  **Conflict:** medium (`Events.tsx`/`EventView.tsx` 9).

### PR-10 · csp-enforce — E6 — M (needs I7)
- **Scope:** collect CSP violations in the demo stack across every page
  (monaco workers, blob players, go2rtc WebRTC page), tighten the policy, then
  switch `Content-Security-Policy-Report-Only` to enforcing in
  `security_headers.conf`.
- **Done when:** full e2e and a demo-stack click-through show zero violations.
- **Impact:** E A− → A (after PLAN.md E4/E5). **Conflict:** low (fork's own file).

### PR-11 · static-assets — G10 — S
- **Scope:** `immutable` for `/assets/`; build-time `.gz` + `gzip_static on`
  (brotli only if the image's nginx has the module).
- **Done when:** response headers verified in the demo stack; reload shows no
  revalidation of hashed chunks. **Impact:** faster repeat visits, less nginx
  CPU. **Conflict:** low.

### PR-12 · live-tiles — UI24, UI25 — S–M
- **Scope:** "Person · 2 min ago" chip on Live tiles linking to the review item;
  long-press / right-click quick actions (snapshot, mute, detect toggle, PTZ
  presets). Flags `tileLastEvent`, `tileActions`. Wait for PLAN.md UI13.
- **Impact:** faster Live workflows. **Conflict:** medium (`LiveCameraView` 7).

### PR-13 · ci-speed and dev loop — I9, I10, I8 (I11 trial on request) — M — **in progress**
- **Status (2026-09-10):** I9 and I10 merged to `main` (the owner renamed
  `polish` to `main` in the same change); dispatched CI green (354 s → 206 s
  warm). Moved ahead of the ordering because every later block benefits.
- **Remaining:** I8 is on hold: the server will pull `:main`, so `main`
  keeps the full image build (see the report). I11 (TypeScript 7 / Vite 8 /
  Vitest 5 trial) moved to PR-28, the majors phase, which runs last.
- **Done when:** a `main` push goes green in well under the current ~6 min
  (target ~3 min; docs-only ~10 s); numbers before/after in the PR.
  **Impact:** faster feedback for every later PR and agent. **Conflict:** none
  (fork workflows and the fork block of the `Makefile`; one-line hunks in
  `web/package.json` scripts).

### PR-14 · mypy waves — I3 — series, L total
- **14a** `ptz` + `video` (273 production errors). **14b** `config` (116).
  **14c** `util` (235). **14d** `detectors` + `embeddings` (414). **14e**
  `api` (535, file by file if needed). Tests stay ignored.
- **Each done when:** the module's `ignore_errors` block is deleted, mypy is
  clean in CI, backend tests green. **Impact:** I B → B+ by 14c.
  **Conflict:** medium (annotations touch upstream files; keep behaviour
  identical).

### PR-15 · playback — UI26 — M
- **Scope:** skip-idle playback in the recordings player (jump gaps with no
  motion/objects using recordings summary data); remembered playback speed per
  device. Flag `skipIdle`. **Conflict:** medium.

### PR-16 · perf-measurement — G11, G12, D7 — M (needs I7)
- **Scope:** py-spy profile of the page-load endpoints in the demo stack; ETag +
  304 for `review_summary` / `recordings_summary` if profiling confirms cost;
  web-vitals budget (LCP/INP/CLS) for Live, Review, Explore in CI; refresh e2e
  fixtures from recorded demo-stack responses (validated by D9).
- **Impact:** G B → B+ once measured and enforced. **Conflict:** low–medium.

### PR-17 · exports-and-search — UI29 (revised), UI33, UI34 — S–M
- **Scope:** date-range filter on Exports reusing `CalendarFilterButton` (no
  activity dots); export progress list + inbox entry on completion + filenames
  with camera and local time; saved and recent searches in Explore.
- **Conflict:** medium (`Exports.tsx` is large).

### PR-18 · clarity — UI30, UI31, UI36 — S
- **Scope:** "reconnecting…" banner on websocket loss (check 0.18 first);
  guided empty states on Review, Explore, Exports; reduced-motion support and a
  high-contrast option in the UI15 appearance menu.

### PR-19 · quick-nav — UI37, UI38 — S
- **Scope:** camera-group quick switch in the command palette and Live;
  copy-diagnostics button (version, browser, redacted config summary, recent
  client errors).

### PR-20 · zone-editor — UI35 — M
- **Scope:** snapping, undo/redo, numeric coordinates, keyboard nudging in the
  zone/mask editor. **Conflict:** medium (`PolygonCanvas`, `ZoneEditPane`).

### PR-21 · activity-heatmap — UI28 — M
- **Scope:** per-camera hour × day grid from review summary data on Review or
  System. Flag `activityHeatmap`.

### PR-22 · push-alerts — UI40 — M
- **Scope:** camera-offline alerts (PLAN.md UI16) also sent through Frigate's
  web push so they arrive with no tab open. Needs HTTPS on the owner's server;
  the owner enables it, agents never touch the server.

### PR-23 · mobile-install — UI18 — M, long term
- **Scope:** install-to-home-screen polish, offline app shell, larger touch
  targets on Live.

### PR-24 · timeline-previews — UI39 — M
- **Scope:** thumbnail preview while scrubbing the timeline; check what 0.18
  already provides first and only fill the gap.

### PR-25 · hygiene — F5, H5, A4 — S
- **Scope:** replace `sort-by`, `strftime`, `nosleep.js`; delete the root stub
  `package-lock.json`; deploy/rollback runbook in `fork/README.md` (docs only,
  never executed by an agent); single config fetch and no dead wrappers in
  `App.tsx` (1 upstream commit in 180 days, low risk).

### PR-26 · cross-camera-stories — UI41 — L
- **Scope:** group consecutive same-label alerts across cameras within a short
  window into one Review card. Flag `stories`. Design note in the PR first.

### PR-27 · structural — A2, C7, A3, C4, C6 — series, L, highest rebase cost
- Order by risk, lowest first: **A2** split `ws.ts` into
  `api/ws/{store,protocol,hooks}.ts` with `ws.ts` re-exporting (only 3
  upstream commits in 180 days, so acceptable); **C7** remove
  `exhaustive-deps` suppressions with a count ratchet (small hunks); **A3**
  service layer, one router per PR, starting with config redaction; **C4**
  `ReviewPageContext`; **C6** god-component splits, `SearchDetailDialog`
  first.
- These move code in upstream files, which FORK.md normally forbids. Do each
  only with the owner's go-ahead at the time, check upstream churn for the
  file first, and prefer doing it as the local split for a feature that
  already has to touch that file.

### PR-28 · dependency majors — F4, I11 — series, L — **last** (owner OK 2026-09-11)
- **When:** after the debugging work and the type-safety blocks (PR-01, PR-02,
  PR-04, PR-14); the owner wants majors eventually, just not first.
- **Order and groups** (one PR each; coupled packages move together):
  1. Toolchain (I11): (a) Vitest 5 + @vitest/coverage-v8 + jsdom +
     @testing-library/jest-dom, which clears the vitest alerts; (b) ESLint 10 +
     @eslint/js + eslint-config-prettier + eslint-plugin-react-hooks + globals;
     (c) Vite 8 + @vitejs/plugin-react-swc (+ the patched
     vite-plugin-monaco-editor); (d) TypeScript 7 (+ typescript-eslint);
     (Prettier 3.9 and @playwright/test 1.63 were done early in F6, with owner OK.)
  2. react-router 7 + react-router-dom (Dependabot #7, 2 alerts).
  3. Runtime groups: i18next + react-i18next + i18next-http-backend;
     date-fns 4 + react-day-picker 10; zod 4 + @hookform/resolvers 5;
     apexcharts + react-apexcharts; then singles in one or two PRs:
     framer-motion, immer, js-yaml, lucide-react, react-dropzone,
     react-markdown, react-zoom-pan-pinch, copy-to-clipboard,
     @types/node. (konva 10.5, monaco-yaml 5.5 and react-logviewer 6.5.5 were
     done early in F6.)
  4. Fork GitHub Actions: checkout 7, setup-node 7, cache 6,
     upload-artifact 7, download-artifact 8, setup-python 7.
  5. Tailwind 4 + tailwind-merge + tailwind-scrollbar + @tailwindcss/forms +
     prettier-plugin-tailwindcss, last (widest diff).
- **Each done when:** `make check` and "Fork - Checks" green, before/after
  timings or bundle size in the PR, no behaviour change unless listed.
  **Conflict:** `package-lock.json` on every upstream sync; re-check on each
  sync whether upstream has since taken the same major.

### PR-29 · camera-resilience — D10, D11, D14, D15 — S — **D10 + D11 done (PR #11), D14 done (PR #24); D15 in review**
- **Status (2026-09-11):** owner request after the server switch: the dining
  room camera's detect stream kept crashing on VAAPI; "it should disable the
  fancy feature and flag a warning, not kill the feed". Branch
  `section/hwaccel`; verified on the real UHD 730 with a throwaway instance
  before review. D11 added the same day: the owner stopped a long external
  benchmark and asked for "better logging and tracking without being
  annoying" inside Frigate instead. D14 (branch `section/health-quiet`): after
  the next update every card said Degraded and the owner "cannot tell if it is
  or not because of the clutter", so Degraded now means lasting trouble,
  start-up shows Starting, and the software switch survives restarts. D15
  (branch `section/health-polish`): the owner said the chart under each card
  "is broken"; it was a one-point dash, so it is now seeded from the server's
  history and drawn against a target line.
- **Done when:** a camera whose hardware decoding keeps crashing detect ends
  up on software decoding with one log warning, a Camera Health reason and a
  status-bar message; other cameras keep hardware decoding.
  **Impact:** a flaky GPU path degrades one camera's efficiency instead of its
  detection. **Conflict:** small hunks in `frigate/video/ffmpeg.py`,
  `frigate/camera/__init__.py`, `frigate/stats/util.py`,
  `web/src/hooks/use-stats.ts`.

---

## Agent prompt: type-safety track (PR-01, PR-02, PR-04, PR-14)

```
You are working on my Frigate UI/UX fork: /Volumes/512Flash/frigate
(github.com/jtn0123/frigate). Read FORK.md, fork/PLAN.md (hard rules, gates,
safety setup, environment gotchas) and the "Type safety" section plus blocks
PR-01, PR-02, PR-04 and PR-14 of fork/PLAN2.md, and items A5, C10, C11, D9,
I3 in fork/GRADE-REPORT.md.

Goal: make API drift and type holes fail CI, without touching more upstream
code than needed. Do the blocks in this order: PR-01, PR-02, PR-04, then the
PR-14 series (14a first). One PR per block (14 is one PR per wave), branch
pr/<nn>-<slug> from main, one commit per item ID, PR against
jtn0123/frigate base main.

Rules:
- Never enable noUncheckedIndexedAccess, exactOptionalPropertyTypes,
  noPropertyAccessFromIndexSignature or no-unnecessary-condition for all of
  web/src, and never turn mypy on for frigate/test. Those are fork-scoped or
  out of scope (see "Strategy" in PLAN2.md).
- No new `any`, `@ts-expect-error`, `as unknown as`, `type: ignore` or
  eslint-disable to get green. If something cannot be typed without a
  rewrite, stop and list it in the PR description.
- Keep hunks in upstream files small; behaviour must not change. Every PR runs
  the full gate list from PLAN.md plus the new ratchet and must be green in
  "Fork - Checks" before you ask me to merge.
- Never touch my live Frigate server. Commits/PRs only on jtn0123 repos.
- At most two agents at once.

For PR-01, prove the contract works: in the PR description, show that changing
one response schema in docs/static/frigate-api.yaml makes tsc fail at a
migrated call site. Report after each PR: what changed, before/after counts
(type ratchet, mypy errors per module), CI status, anything needing my call.
```
