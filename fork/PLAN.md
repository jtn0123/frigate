# Fork work plan

The single source of truth for work on this fork. Read `FORK.md` first for the
rebase rules. This file says what is next, in order, and how to do it.

## Start here (new agent)

1. Read `FORK.md`, this file, and the report entries for your items in
   `fork/GRADE-REPORT.md`.
2. Take the next unchecked section from **The queue**. On this Mac, its worktree
   lives under `/Volumes/512Flash/frigate-wt/<name>` (create it if missing:
   `git worktree add /Volumes/512Flash/frigate-wt/<name> -b section/<name> polish`).
   On another machine, clone `jtn0123/frigate` and set up the local guards in
   **Safety setup** first.
3. `git fetch origin && git rebase origin/polish` in the worktree.
4. Build, commit per item, run every gate in **Workflow per section**.
5. Only the coordinating agent merges into `polish`, pushes it, and ticks the
   box here, so two agents never race on the same branch.

## Goal

A UI/UX-focused fork of Frigate that stays easy to rebase onto upstream.
Phase 1 finishes the original 30 items (top 15 non-UI + top 15 UI/UX from the
grade report, overall B−). Phases 2–3 keep the fork healthy and raise quality.
The backlog holds ideas that wait for the owner to promote them.

- Base: upstream `v0.18.0-rc2`. Repo `github.com/jtn0123/frigate`, clone at
  `/Volumes/512Flash/frigate`.
- Work branch `polish` (the GitHub default branch). `dev` mirrors upstream and
  is never committed to.

## Hard rules

- Never touch the owner's live Frigate server (Proxmox LXC 106) or its Portainer
  stack: no deploys, no API calls, no pointing dev tools at it. Pushing to
  GitHub is allowed.
- Commits, pushes, PRs and issues go only to `github.com/jtn0123/*`. Never open
  a PR, issue or comment on `blakeblackshear/frigate`. Use
  `gh pr create --repo jtn0123/frigate --base polish`.
- No camera passwords, tokens or credentials in git or docs. Root `.env*` files
  are gitignored; keep secrets there.
- Small, additive changes: new files over edits; small self-contained hunks
  when an upstream file must change; never rename, move or reformat an upstream
  file; no dependency majors upstream has not taken.
- Gate fork-only UI behaviour behind a flag in `web/src/fork/flags.ts`
  (overridable at runtime with `localStorage.frigateFork` JSON).
- Fork strings go in the `fork` i18n namespace (`web/public/locales/en/fork.json`).
- One item = one commit, subject prefixed with the item ID (`UI6: ...`).
  Commits end with the `Co-Authored-By` trailer. Git author
  `Justin <jtn0123@gmail.com>`. Add a `FORK.md` ledger row per item.
- Fix bugs and warnings found along the way. Never skip, disable or loosen a
  failing test or lint rule to get green; fix it, or add it to **Follow-ups**.
- At most two agents at once (usage limit). Suggested pairs are in the queue.
- Backlog items are not started unless the owner promotes them.

## The queue

Tick a box only after the section is merged into `polish`, pushed, and
"Fork - Checks" is green on that commit. Pairs on the same line can run in
parallel; each needs its own `E2E_PORT`.

### Phase 1 — finish the original 30

- [ ] **1a. features1** — UI6 command palette, UI12 camera health cards, UI14
  notification inbox. `section/features1` has 3 commits on an old base: rebase,
  resolve `FORK.md`, gates (`E2E_PORT=4185`), fix anything red.
  *Pair with 1b.*
- [ ] **1b. security** (coordinator) — see **Security triage** below.
- [ ] **2a. features2** — UI7 settings navigation, UI10 bulk actions with undo.
  `section/features2` has one `wip:` commit: `git reset --soft HEAD~1`, finish,
  one commit each (`E2E_PORT=4186`). *Pair with 2b.*
- [ ] **2b. ops** — A upstream-sync bot, C bundle budget, H typed env.
- [ ] **3a. features3** — UI8 timeline scrubber, UI9 shared event header,
  UI11 clip sharing. Branch exists, no work yet (`E2E_PORT=4187`).
  *Pair with 3b.*
- [ ] **3b. demo** — D local demo stack.
- [ ] **4a. features4** — A1/UI5 viewport hook + D3 tablet project, UI13 live
  layout memory + PiP, H3 frontend READMEs. `section/features4` has one `wip:`
  commit of 17 unreviewed files on an old base: `git reset --soft HEAD~1`,
  keep only what is sound, rebase (`E2E_PORT=4188`). *Pair with 4b.*
- [ ] **4b. e2e-coverage** — E (report D2) e2e for the riskiest screens.

### Phase 2 — quality on top of the finished features

- [ ] **5a. settings-save** — F (report C3), after features2. *Pair with 5b.*
- [ ] **5b. camera-alerts** — I, after features1.
- [ ] **6. storage-forecast** — promoted from the backlog by the owner.
- [ ] **7. visual** — B screenshot tests, after all UI sections so baselines
  do not churn.
- [ ] **8. a11y-ratchet** — G, last before closing (touches many files).

### Phase 3 — closing pass

- [ ] **9. closing** — see **Closing pass** below.

## Section specs

### 1b. Security triage (coordinator, any time before closing)

Dependabot: 221 alerts at first scan, all inherited from upstream rc2. 125 are
in `docs/` and 16 in TensorRT/ARM manifests this fork does not build; those are
ignored in `.github/dependabot.yml`. What ships: `python-multipart` (2 high) in
`docker/main/requirements-wheels.txt` and the `/web` lockfile (axios, fast-uri,
nanoid, postcss, form-data and others; the vitest critical is dev-only).

- Merge the grouped `security` PRs for `/web` and `/docker/main` once
  "Fork - Checks" is green on them; add a `SEC` ledger row.
- PRs #1–#6 are single-package PRs opened before grouping was configured, on a
  base with a since-fixed CI error. If the grouped PR covers them, close them
  with a comment; otherwise `@dependabot rebase` and merge if green.
- Patch and minor bumps only. For a major, leave the alert open and note it
  under **Follow-ups**.
- On upstream rebases, take upstream's `package-lock.json` and re-run
  `npm install` rather than hand-merging it.

CodeQL (first scan 2026-09-10): no alert is in fork code. Fix as small
"candidate" commits with ledger rows, or dismiss with a written reason:

- critical `py/command-line-injection` `frigate/util/image.py:1221`,
  `frigate/util/services.py:1017`; `py/full-ssrf` `frigate/api/camera.py:505`
- high `py/clear-text-logging-sensitive-data` `frigate/api/auth.py` (331–384),
  `frigate/app.py` (537, 555), `frigate/util/services.py:1021`
- high `py/polynomial-redos` `frigate/util/builtin.py:113,123`
- medium `actions/missing-workflow-permissions` in the disabled upstream
  workflows (ci, pull_request, release, stale): dismiss as "won't fix".

### 2b. ops — A sync bot, C bundle budget, H typed env

**A. Upstream-sync bot** — `.github/workflows/fork-upstream-sync.yml`, daily
schedule + `workflow_dispatch`, `permissions: contents: write, issues: write,
actions: write`.

- Fetch `https://github.com/blakeblackshear/frigate` (read-only) `dev` + tags.
- Fast-forward `origin/dev` to `upstream/dev` (ff only; never force).
- If `polish` already contains `upstream/dev`, stop.
- Otherwise rebase a copy of `polish` onto `upstream/dev`. Clean: force-push
  it to `sync/upstream` only, dispatch "Fork - Checks" on that ref
  (`gh workflow run` — pushes made with `GITHUB_TOKEN` do not trigger
  workflows), and open or update one issue "Upstream moved N commits" with the
  commit list and a link to the run. Conflict: open or update the issue with
  the conflicted files and the upstream commits that touched them.
- A new upstream `v*` tag (e.g. 0.18.0 final) opens its own issue.
- Never push `polish` or tags. Issues are enabled on the repo.
- Add `sync/**` to "Fork - Checks" `workflow_dispatch`-able refs if needed, and
  document the bot in `FORK.md`.

**C. Bundle budget** — `web/scripts/fork/bundle-budget.mjs` reads
`dist/index.html`, gzips every eagerly loaded script, `modulepreload` and
stylesheet, prints a table, and fails when the total exceeds
`fork/bundle-budget.json` (start at the measured size + 5%; eager JS was
305 kB gzip after the perf section). Run it in the "Web - Unit tests + build"
job after `npm run build`, plus an npm script `bundle:budget`. Raising the
budget needs a sentence in the commit explaining why.

**H. Typed env (report I5, mostly done by S0)** — e2e typecheck and
`web/.env.example` already exist. Remaining: declare `VITE_GIT_COMMIT_HASH`
in an `ImportMetaEnv` interface in `web/src/vite-env.d.ts`, and document
`E2E_PORT` in `web/.env.example`.

### 3b. demo — D local demo stack

A real Frigate with the fork's UI and backend running on this Mac, for
dogfooding and screenshots. Never uses or copies anything from the live server.

- `fork/demo/`: `Dockerfile` (FROM `ghcr.io/blakeblackshear/frigate:0.18.0-rc2`,
  which is multi-arch, so it runs native arm64; overlay `frigate/`,
  `migrations/` like `fork/Dockerfile.test`, and `web/dist` over the image's
  web root — find the path nginx serves), `compose.yml`, `config/config.yml`,
  `README.md`, and `fetch-samples.sh`.
- Cameras: 2–3 fake cameras from looping sample clips via go2rtc/ffmpeg
  (`-stream_loop -1 -re`). At least one clip with people or cars so the CPU
  detector produces review items. Clips and all state (db, recordings) live in
  gitignored `fork/demo/.data/` or under `/Volumes/512Flash/frigate-demo/`.
  Document the source and licence of each clip; never commit media.
- Ports bound to `127.0.0.1` only. Auth on; credentials in gitignored
  `fork/demo/.env`.
- `Makefile` targets `demo-up`, `demo-down`, `demo-logs`.
- Done when: `make demo-up` gives a working UI with live video, and review
  items appear within a few minutes. Include screenshots of Live, Review,
  Explore and System in the report.
- Then dogfood Phase 1 features in it and add findings to **Follow-ups**.

### 4b. e2e-coverage — E (report D2)

Mocked-API Playwright specs, desktop and `@mobile` (the spec linter requires
both), asserting request payloads, not just UI:

- Settings: edit a field, unsaved indicator, Save All sends the right body,
  restart-required notice.
- Motion search: draw a region, run, results render, empty state.
- Zone editing: add and move points, save payload, validation.
- Camera wizard: each step, validation errors, final config payload.

### 5a. settings-save — F (report C3, as a local split)

Not a rewrite. Extract the Settings "Save All" transaction (collect pending
changes → build `config/set` payloads → send → handle partial failure and
restart-required) from `Settings.tsx` into `web/src/lib/fork/settings-save.ts`
with vitest coverage of ordering, partial failure and restart-required. The
hunk in `Settings.tsx` stays small. Builds on UI7's diff dialog.

### 5b. camera-alerts — I

Client-side v1, no backend: detect a camera going down (fps 0, or the 0.18
connection-quality state offline/poor, for longer than a debounce window) from
the same stats data as UI12, and raise a UI14 inbox entry, plus a browser
notification when a tab is open, respecting quiet hours. Recovery clears it.
Flag `cameraAlerts`. Vitest for debounce and recovery; e2e flipping the
mocked stats websocket.

### 6. storage-forecast

Answer "how long until the disk fills, and what retention can I afford?"

- Backend (small, fork-only): `frigate/api/fork_storage.py` with
  `GET /api/fork/storage/daily?days=30` returning bytes recorded per camera per
  day, from `SUM(Recordings.segment_size)` (MB) grouped by local day of
  `start_time`. Admin-only via the E2 per-route auth marker, same as the
  existing `/recordings/storage`. Tests in the thin image.
- Model: with retention, usage settles at about daily bytes × retain days per
  camera (continuous vs. alert/detection retention differ; read them from the
  config). Show current usage, projected steady state, free space, and either
  "fills in N days" or "headroom for N more days of retention".
- UI: a card on the System storage view (`web/src/views/system/StorageMetrics.tsx`
  is the host; keep that hunk small, card in `web/src/components/fork/`), a
  30-day per-camera stacked bar using the existing apexcharts vendor chunk, and
  a retention simulator: pick days per camera, see projected size. Flag
  `storageForecast`. Handle less than 3 days of history with a clear message.
- Vitest for the projection maths (steady state, growth, empty data); e2e with
  mocked endpoint, desktop and `@mobile`. Dogfood in the demo stack.

### 7. visual — B screenshot tests

Playwright `toHaveScreenshot` in a separate `visual` project: about 8 views
(Live, Review, Explore, System health, Settings, error boundary, command
palette, OLED appearance) × desktop and mobile. Mocked data, animations off,
dynamic regions (times, video) masked, `maxDiffPixelRatio` ≈ 0.01.
Baselines must be rendered on Linux to match CI: add a `workflow_dispatch`
input to "Fork - Checks" that runs with `--update-snapshots` and uploads the
snapshot folder as an artifact; commit it from there. The `visual` project runs
in CI; locally on macOS it runs only when `E2E_VISUAL=1` inside the matching
`mcr.microsoft.com/playwright` container (same version as `@playwright/test`).

### 8. a11y-ratchet — G

83 jsx-a11y warnings remain (label-has-for 24, no-noninteractive-tabindex 13,
no-static-element-interactions 11, control-has-associated-label 9,
no-autofocus 8, click-events-have-key-events 5, role-has-required-aria-props 4,
media-has-caption 3, aria-role 3, no-noninteractive-element-to-interactive-role
2, heading-has-content 1). Fix one rule per commit, then switch that rule to
`error` in `web/eslint.config.js`. No `eslint-disable` comments; if a site
cannot be fixed without a rewrite, leave that rule at `warn` and list the
sites under **Follow-ups**.

### 9. Closing pass

- Rebase `polish` onto the newest upstream tag (rc2 or later) and re-run every
  gate.
- Tag `fork/<version>` and push it; "Fork - Build image" publishes
  `ghcr.io/jtn0123/frigate`. Do not deploy.
- Regrade `fork/GRADE-REPORT.md`.
- List the "candidate" ledger rows that would make good upstream PRs, bug
  fixes first. Do not open them; the owner decides.
- Remove merged worktrees and `section/*` branches (local and origin).

### Scope notes for Phase 1 features (0.18 already ships part of some)

- **UI7**: only what 0.18 lacks — scrollspy section rail, settings search,
  before/after diff dialog ahead of Save All. Flag `settingsNav`.
- **UI10**: multi-select in Explore plus an undo toast for Review "mark
  reviewed". Flag `bulkActions`.
- **UI12**: builds on 0.18's connection-quality indicator and stats data
  (`views/fork/CameraHealthView.tsx`, System page tab).
- **UI8**: snap-to-event, arrow-key stepping, bigger touch targets. Flag
  `timelineScrubber`.
- **UI9**: a shared `EventSummaryHeader` for Review and Explore detail panels.
  Flag `unifiedEventDetail`.
- **UI11**: `frigate/api/fork_share.py`, a `ShareLink` model + migration,
  tests, QR helper `web/src/lib/fork/qr.ts`. Public `GET /share/{token}` uses
  the E2 per-route auth marker (`allow_public`), never a path exemption.
  Tokens expire. Flag `clipSharing`.
- **A1/UI5**: `web/src/hooks/fork/use-viewport.ts` for shell and nav only, plus
  **D3** tablet 1024×768 Playwright project. Flag `viewportLayout`.
- **UI13**: per-device live layout memory and picture-in-picture. Flag
  `liveLayoutMemory`.
- **H3**: `web/README.md`, `web/e2e/README.md`, `web/patches/README.md`.

## Backlog — do not start unless the owner promotes it

Rough size S/M/L. Promote by moving an item into the queue.

- **J. Installable mobile app polish** (M) — better install-to-home-screen,
  offline app shell, larger touch targets on Live. Long term.
- **Kiosk / wall-display mode** (M) — `?kiosk=1` chrome-less Live view, camera
  auto-cycle, OLED burn-in pixel shift, night dimming, wake on motion. Fits the
  owner's Tab S6 kitchen panel.
- **Review triage keys** (S) — j/k next/previous, space play/pause, r mark
  reviewed, e export, `?` cheat sheet.
- **Morning digest** (S) — card at the top of Review: overnight counts per
  camera and label with jump links, from the existing review summary API.
- **Activity heatmap** (M) — per-camera hour × day grid from review summary.
- **Setup health checklist** (S) — auth on, admin password changed, HTTPS
  (needed for web push), notifications, retention, detector not CPU; each links
  into Settings.
- **Copy diagnostics** (S) — button that copies version, browser, a redacted
  config summary and recent client errors for bug reports.
- **Zone editor UX** (M) — snapping, undo/redo, numeric coordinates, keyboard
  nudging.
- **Saved searches** (S) — pin Explore filter sets; shareable URLs.
- **Export queue UX** (S) — progress list, inbox entry when an export finishes,
  filenames with camera and local time.
- **Virtualised card grids** (M) — the unfinished half of G5 for Review and
  Explore with thousands of items.
- **Reduced motion + high-contrast theme** (S) — extends UI15.
- **API contract check** (M) — generate TS types from
  `docs/static/frigate-api.yaml` and type web API calls against them, so an
  upstream API change fails the build after a rebase instead of at runtime.
- **Refresh e2e mocks from the demo stack** (S) — record real responses from D
  to keep fixtures realistic.
- **Server-side camera-offline push** (M) — extend I with Frigate's web push so
  alerts arrive with no tab open (needs HTTPS on the owner's server).
- **Camera-group quick switch** (S) — groups in the command palette and Live.
- **Deploy/rollback runbook** (S) — docs only: how the owner would point the
  Portainer stack at `ghcr.io/jtn0123/frigate:<tag>` and back, and what to
  check. Never executed by an agent.
- Unscheduled report items: A2 (split `ws.ts`), A3, A4, B2, B4, D4, F4, F5,
  H4, C4, C6, C7. C4/C6 are rewrites; only local splits when a feature touches
  the file.

### Backlog — more UI/UX (brainstorm 2026-09-10)

"Verify" means 0.18 may already have part of it; check before building.

- **Last-event chip on Live tiles** (S) — "Person · 2 min ago" on each tile,
  tap to jump to that review item.
- **Tile quick actions** (S) — long-press / right-click a tile: snapshot,
  mute, detect on/off, PTZ presets.
- **Skip-idle playback** (M) — recordings player jumps over stretches with no
  motion or objects; remembers playback speed per device.
- **Swipe to review on mobile** (S) — swipe a Review card to mark it reviewed,
  with the UI10 undo toast.
- **Cross-camera stories** (L) — group consecutive alerts of the same label
  across cameras within a short window into one card (driveway → porch).
- **Calendar with activity dots** (S) — date picker shows which days had
  alerts and how many.
- **Timeline hover previews** (M, verify) — thumbnail preview while scrubbing.
- **Connection banner** (S, verify) — clear "reconnecting…" banner with retry
  countdown when the websocket drops, instead of stale data.
- **Recent and suggested searches** (S) — dropdown in Explore search.
- **Guided empty states** (S) — "No alerts today; 6 cameras watching" with
  links, instead of blank panels.
- **Undo for destructive actions** (M) — deleting clips and exports gets the
  same undo toast as UI10.
- **Performance advisor** (M) — System page panel that reads config + stats and
  flags fixable costs: detect resolution or fps higher than needed, no hwaccel,
  more than one connection per camera without go2rtc restream, Birdseye on but
  unused, decoder restarts (the Tapo case). Each tip links to the setting and
  the docs. Client-side rules only. Pairs with the storage forecast.
- **Retention simulator on its own** (S) — if the storage forecast ships, also
  offer it inside camera record settings.

### Backlog — performance, all layers (brainstorm 2026-09-10)

Measured or checked in code on 2026-09-10 unless marked "verify".

Frontend load:
- **Settings chunk diet** (M) — `ConfigSectionTemplate` is 246 kB gzip (rjsf +
  ajv8 compiling schemas at runtime). Precompile validators at build time (ajv
  standalone) or load the validator on first validation. Settings opens much
  faster.
- **Immutable hashed assets** (S) — `/assets/` sends `expires 1y` +
  `Cache-Control: public` but not `immutable`, so reloads still revalidate
  every chunk. Small nginx hunk.
- **Precompressed assets** (S) — nginx gzips on the fly at level 6; emit `.gz`
  at build and turn on `gzip_static` for `/assets/` (brotli only if the image's
  nginx has the module; verify).
- **Keep heavy vendors off the critical path** (S, verify) — monaco 1 MB gzip,
  hls.js 164 kB, charts 140 kB, konva 99 kB are split out; confirm none is
  `modulepreload`-ed from `index.html` and hls.js never loads where native HLS
  works.
- **Route prefetch on hover/idle** (S) — prefetch the Review/Explore chunks
  when the nav item is hovered or the browser is idle.

Frontend runtime:
- **Lazy, async images** (S) — only 9 of 33 `<img>` use `loading="lazy"` /
  `decoding="async"`.
- **Virtualised grids** (M) — nothing in the app virtualises today (already in
  the backlog above; it is the biggest runtime win for long Review/Explore
  lists).
- **Stream bandwidth audit** (M) — measure bytes/s with 8 cameras on the Live
  dashboard in the demo stack: grid tiles on sub streams, offscreen and
  hidden-tab tiles paused (players already listen for visibility; verify every
  path).
- **Re-render audit** (S) — React Profiler pass in the demo stack for
  components that re-render on every stats or camera_activity message (the
  websocket store already uses per-topic `useSyncExternalStore`, so look at
  consumers).
- **Web-vitals budget** (M) — record LCP/INP/CLS for key pages in the demo
  stack (Lighthouse CI or `web-vitals`), and fail CI on regressions like the
  bundle budget does.

Backend/API:
- **Profile the page-load endpoints** (M) — py-spy against the demo stack while
  loading Live, Review, Explore; fix the slowest five.
- **ETag / 304 for summary endpoints** (M) — review and recording summaries are
  recomputed per request; key an ETag on the newest row so repeat loads are
  304s.
- **Sized, WebP thumbnails** (M) — serve thumbnails at the width the grid needs
  and as WebP where supported; grids download far less.
- **SQLite tuning** (S) — WAL, `synchronous=NORMAL` and a 512 MB cache are
  already set; add `mmap_size` and a periodic `PRAGMA optimize`, and check the
  indexes behind review and timeline queries (pairs with report B4).
- **Faster JSON** (S, verify) — `ORJSONResponse` for large list endpoints if
  orjson is already in the image.

Build and CI:
- **Overlay image for fast builds** (M) — the full image build takes about 40
  minutes cold. For branch/test images, layer `frigate/`, `migrations/` and
  `web/dist` over the upstream image (like `fork/Dockerfile.test`) in a few
  minutes; keep the full build for `fork/*` release tags, since F2/F3 change
  Docker dependencies.
- **Shard e2e in CI** (S) — split Playwright across 2–3 runners.
- **Cache the thin test image** (S) — push `frigate-fork-test` to GHCR keyed on
  its inputs instead of rebuilding each run.
- **Changed-only local e2e** (S) — `make e2e-changed` using Playwright
  `--only-changed` for the inner loop.

## Workflow per section

1. Worktree `/Volumes/512Flash/frigate-wt/<name>` on `section/<name>`, rebased
   onto the latest `polish`. Push the section branch to origin as a backup.
2. Implement and commit per item.
3. Gates — these mirror every job in `.github/workflows/fork-checks.yml`:
   ```
   cd web
   npx tsc --noEmit
   npx tsc -p tsconfig.e2e.json      # e2e typecheck (CI "Web - Lint")
   npm run lint                      # eslint + e2e:lint spec linter
   npx vitest run
   npm run i18n:extract:ci
   npm run build
   E2E_PORT=<unique port> npx playwright test -c e2e/playwright.config.ts
   cd .. && gitleaks git --no-banner --redact --log-opts="upstream/dev..HEAD" .
   ```
   Backend changes also need `ruff check frigate migrations && ruff format
   --check frigate migrations` and `make fork-test-image && make test-py
   check-py` (thin test image over rc2, see `fork/Dockerfile.test`).
4. Rebase onto `polish`. `FORK.md` conflicts on every rebase: keep both sides'
   rows (rerere is on, so a resolution is replayed next time). Fast-forward
   `polish`, re-run the gates in the main checkout, `git push origin polish`.
5. Confirm CI: `gh run list -R jtn0123/frigate --branch polish --limit 3`.
   Red "Fork - Checks" is a bug to fix before the next section.

## Safety setup (already configured)

GitHub `jtn0123/frigate`: default branch `polish`; secret scanning + push
protection; Dependabot alerts + grouped security updates (version updates off);
CodeQL default setup (Python, JS/TS, Actions); rulesets stop deletion of
`polish`/`dev` and deletion or moving of `fork/*` tags (force-push on `polish`
stays allowed for rebases); upstream workflows CI, On pull request, PR template
check, On release and Stalebot are disabled; Issues enabled for the sync bot;
"Fork - Checks" runs gitleaks over `origin/dev..HEAD`.

Local clone (shared by all worktrees, not tracked by git):
`gh repo set-default jtn0123/frigate`; `upstream` push URL `no_push`;
`.git/hooks/pre-push` allows only `github.com/jtn0123/*` and gitleaks-scans the
pushed range; `pre-commit install` (ruff, gitleaks, eslint, prettier; needs
`web/node_modules`); `rerere.enabled`.

### Environment gotchas

- Never run `npx playwright install`: the CDN returns HTTP 400 for
  `chromium_headless_shell-1217` here. `~/Library/Caches/ms-playwright` has
  symlinks `chromium_headless_shell-1217 -> …-1234` and `chromium-1217 -> …-1234`.
- Unique `E2E_PORT` per worktree when two suites run at once.
- Never two `npm ci` in one directory. `rm -rf node_modules` (and removing a
  worktree) on the USB volume takes ~20 minutes; run it in the background.
- In zsh, never name a shell variable `path` (it overwrites `PATH`).
- The harness blocks chained `sleep`; use until-loops or background commands.
- Docker Desktop is arm64; the rc2 image is already pulled.

## Done (merged on `polish`)

21 of the 30, with e2e 331 passed / 95 skipped and 978 backend tests OK at the
last full run:

- Non-UI (all 15): D1 unit tests, I1 pre-commit + CI caching, G3 non-blocking
  handlers, G4 bounded event search, E1 security headers, E2 per-route auth
  markers, F2 checksummed downloads, F1 ESLint 9, F3 wheel cleanup, D5
  coverage, B1 one error shape, B3 logged exception swallows, G6 recording
  cache tracker, I2 Makefile targets, H1/H2 docs.
- UI: C1 error boundary, C2 keyboard + screen-reader access, G1/G5/UI3 first
  paint (eager JS 504 → 305 kB gzip), C5 error states, UI15 theme controls.
- Extras: I3 mypy ratchet, I4 ruff S rules, E3 safe_join thumbnails, C8 dev
  sandbox out of prod, G2 SWR policy, T1 config editor Cmd/Ctrl+S, S0 fork
  scaffold, CI secret scanning and repo safety setup.

## Follow-ups

- Owner question (open): cut UI14 notification inbox and UI11 clip sharing to
  keep the fork lighter? Default is to build both.
- Live-server tweaks were proposed but never approved (Tapo software decode,
  disabling `out_1..4`, camera renames). Leave them alone.
