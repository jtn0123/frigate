# Fork work plan

Handoff doc for any agent picking up work on this fork. Read `FORK.md` first for
the rebase rules; this file explains what is being built, what is done, and how
to finish the rest.

## Start here (new agent)

1. Read `FORK.md`, this file, and the report entries for your items in
   `fork/GRADE-REPORT.md`.
2. Take one section from "Remaining work" below. On this Mac, use its worktree
   under `/Volumes/512Flash/frigate-wt/`. On another machine, clone
   `jtn0123/frigate`, check out `section/<name>` from origin, and set up the
   local guards from "Safety setup" first.
3. `git fetch origin && git rebase origin/polish` in the section worktree.
4. Build, commit per item, run every gate in "Workflow per section", then
   report back. Only the coordinating agent merges into `polish` and pushes it,
   so two agents never race on the same branch.

## Goal

A UI/UX-focused fork of Frigate that stays easy to rebase onto upstream. The
work covers 30 items: the top 15 non-UI fixes and the top 15 UI/UX
improvements from a codebase grade (overall B−). The full grade report, with
item IDs A1–I5, is `fork/GRADE-REPORT.md`.

- Base: upstream `v0.18.0-rc2` (upstream `dev` was identical to that tag when
  work started).
- Repo: `github.com/jtn0123/frigate`, clone at `/Volumes/512Flash/frigate`.
- Work branch: `polish`. `dev` mirrors upstream and is never committed to.

## Hard rules

- Never touch the owner's live Frigate server (Proxmox LXC 106) or its Portainer
  stack. Pushing to GitHub is allowed; deploying to the server is not.
- Commits, pushes and PRs go only to `github.com/jtn0123/*`. Never open a PR,
  issue or comment on `blakeblackshear/frigate`. Use
  `gh pr create --repo jtn0123/frigate --base polish` for PRs. A clone made
  elsewhere needs the guards from `FORK.md` set up again.
- Do not put camera passwords, tokens or credentials in git or docs. Root
  `.env*` files are gitignored; keep secrets in those, never in tracked files.
- Small, additive changes: new files over edits; small self-contained hunks
  when an upstream file must change; never rename, move or reformat an upstream
  file; no dependency majors upstream has not taken.
- Gate fork-only UI behaviour behind a flag in `web/src/fork/flags.ts`
  (overridable at runtime with `localStorage.frigateFork` JSON).
- Fork strings go in the `fork` i18n namespace (`web/public/locales/en/fork.json`).
- One report item = one commit, subject prefixed with the item ID
  (`UI6: ...`). Commits end with the `Co-Authored-By` trailer. Git author is
  `Justin <jtn0123@gmail.com>`.
- Add a row to the `FORK.md` ledger for every item.
- Fix bugs and warnings found along the way (logs, lint, tests). Never skip or
  disable a failing test; fix it or list it under "Follow-ups" below.
- Run at most two agents at once (usage limit).

## Workflow per section

1. Section branch `section/<name>` in a worktree at
   `/Volumes/512Flash/frigate-wt/<name>`, rebased onto the latest `polish`.
2. Implement and commit per item.
3. Verify inside the worktree. These mirror every job in
   `.github/workflows/fork-checks.yml`; all must pass:
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
   check-py` (thin test image over the rc2 image, see `fork/Dockerfile.test`).
4. Rebase onto `polish`. `FORK.md` conflicts on every rebase: keep both sides'
   rows. Then fast-forward merge into `polish`, re-run the gates in the main
   checkout, and `git push origin polish`.
5. After the push, confirm CI is green:
   `gh run list -R jtn0123/frigate --branch polish --limit 2`. A red
   "Fork - Checks" run is a bug to fix before starting the next section.

## Safety setup (already configured)

GitHub, `jtn0123/frigate`:

- Default branch is `polish` so Dependabot security PRs, CodeQL and the repo
  page all track the fork's real code. `dev` stays a pure upstream mirror.
- Secret scanning and push protection on. Dependabot alerts and Dependabot
  security updates on (PRs target `polish`). Dependabot *version* updates are
  deliberately off: version bumps arrive by rebasing onto upstream, and the
  fork takes no majors upstream has not.
- CodeQL default setup for Python, JavaScript/TypeScript and Actions.
- Rulesets: `polish` and `dev` cannot be deleted; `fork/*` tags cannot be
  deleted or moved. Force-push on `polish` stays allowed because the branch is
  rebased onto upstream.
- Upstream workflows that do not fit a fork are disabled in Actions settings:
  CI, On pull request, PR template check, On release, Stalebot. Active:
  Fork - Checks, Fork - Build image, CodeQL, Dependency Graph.
- Fork - Checks runs gitleaks over `origin/dev..HEAD` (fork commits only; some
  upstream test fixtures contain fake keys that would trip a full scan).

Local clone (shared by every worktree, not tracked by git):

- `gh repo set-default jtn0123/frigate`; `upstream` push URL is `no_push`.
- `.git/hooks/pre-push` refuses any URL outside `github.com/jtn0123/*` and runs
  gitleaks over the pushed range.
- `pre-commit install` done: ruff, gitleaks (staged changes), eslint and
  prettier run on every commit. Needs `web/node_modules` in the worktree.

### Environment gotchas

- Never run `npx playwright install`. The CDN returns HTTP 400 for
  `chromium_headless_shell-1217` from this network. The cache has symlinks
  `chromium_headless_shell-1217 -> chromium_headless_shell-1234` and
  `chromium-1217 -> chromium-1234` under `~/Library/Caches/ms-playwright`.
- Use a different `E2E_PORT` per worktree when two suites run at once.
- Do not run two `npm ci` in the same directory, and avoid `rm -rf node_modules`
  on the USB volume (about 20 minutes).
- The harness blocks chained `sleep`; use until-loops or background commands.

## The 30 items and status

Status as of 2026-09-10. `polish` = merged and pushed to origin (e2e 331
passed / 95 skipped, backend 978 tests OK). `upstream/dev` still equals
`v0.18.0-rc2`, so no upstream rebase is pending. Section branches are pushed
to origin as backups; `section/features2` and `section/features4` carry a
`wip:` commit holding unreviewed partial work (split it into per-item commits
before merging).

### Non-UI (15)

| # | ID | Item | Section | Status |
|---|----|------|---------|--------|
| 1 | D1 | Restore frontend unit tests (vitest + jsdom) | tooling | polish |
| 2 | I1 | Pre-commit hooks and CI caching | tooling | polish |
| 3 | G3 | Stop blocking the event loop in async handlers | backend | polish |
| 4 | G4 | Bound `/events/search` in SQL | backend | polish |
| 5 | E1 | Security headers and HSTS inheritance fix | backend | polish |
| 6 | E2 | Per-route auth markers + startup assertion | backend | polish |
| 7 | F2 | Checksum binary downloads | backend | polish |
| 8 | F1 | ESLint 9 flat config + typescript-eslint 8 | tooling | polish |
| 9 | F3 | Clean the Python wheel set | backend | polish |
| 10 | D5 | Coverage in CI | tooling | polish |
| 11 | B1 | One error response shape | backend | polish |
| 12 | B3 | Log silent exception swallows | backend | polish |
| 13 | G6 | Recording maintainer stops polling every host process | backend | polish |
| 14 | I2 | Inner-loop Makefile targets | scaffold | polish |
| 15 | H1/H2 | Fix wrong docs, CONTRIBUTING matches CI | backend | polish |

Also merged: I3 (mypy ratchet), I4 (ruff S rules), E3 (safe_join thumbnails),
C8 (dev sandbox out of prod routes), G2 (global SWR policy), T1 (config editor
Cmd/Ctrl+S).

### UI/UX (15)

| # | ID | Item | Section | Status |
|---|----|------|---------|--------|
| 1 | C1 | Route error boundary, never a blank page | foundations | polish |
| 2 | C2 | Keyboard and screen-reader access | a11y | polish |
| 3 | G1/G5/UI3 | Faster first paint (icons, lazy players, chunks, font preload) | perf | polish |
| 4 | C5 | Honest empty and error states | foundations | polish |
| 5 | A1/UI5 | Layout follows the viewport, not the user agent | features4 | partial, uncommitted |
| 6 | UI6 | Command palette (Cmd/Ctrl+K) | features1 | committed, needs rebase + verify |
| 7 | UI7 | Settings navigation (narrowed) | features2 | in progress, uncommitted |
| 8 | UI8 | Timeline scrubber (narrowed) | features3 | not started |
| 9 | UI9 | One event detail header for Review and Explore | features3 | not started |
| 10 | UI10 | Bulk actions with undo (narrowed) | features2 | in progress, uncommitted |
| 11 | UI11 | Share a clip (expiring link + QR) | features3 | not started |
| 12 | UI12 | Camera health cards | features1 | committed, needs rebase + verify |
| 13 | UI13 | Live dashboard layout memory + PiP | features4 | partial, uncommitted |
| 14 | UI14 | Notification inbox with quiet hours | features1 | committed, needs rebase + verify |
| 15 | UI15 | Theme controls (density, text size, OLED black) | foundations | polish |

### Scope notes (0.18 already ships part of some items)

- **UI7** only adds what 0.18 lacks: a scrollspy section rail, settings search,
  and a before/after diff dialog ahead of Save All. Files so far:
  `components/fork/settings/{SettingsNav,SettingsReviewDialog}.tsx`,
  `hooks/fork/use-settings-nav.ts`, `lib/fork/settings-diff.ts` (+ test),
  `e2e/specs/fork/settings-nav.spec.ts`. Flag `settingsNav`.
- **UI10** adds multi-select in Explore plus an undo toast for Review
  "mark reviewed". Files so far: `components/fork/bulk/BulkActionBar.tsx`,
  `hooks/fork/use-bulk-selection.ts` (+ test), `lib/fork/bulk-actions.tsx`,
  `e2e/specs/fork/bulk-actions.spec.ts`. Flag `bulkActions`.
- **UI12** builds on 0.18's connection-quality indicator and stats data rather
  than new backend work (`views/fork/CameraHealthView.tsx`, System page tab).
- **UI8** is snap-to-event, arrow-key stepping and bigger touch targets only.
  Flag `timelineScrubber`.
- **UI9** is a shared `EventSummaryHeader` used by both Review and Explore
  detail panels. Flag `unifiedEventDetail`.
- **UI11** needs a small backend piece: `frigate/api/fork_share.py`, a
  `ShareLink` model + migration, tests, and a QR helper in
  `web/src/lib/fork/qr.ts`. The public `GET /share/{token}` must use the E2
  per-route auth marker (`allow_public`), not a path-string exemption. Tokens
  expire. Flag `clipSharing`.
- **A1/UI5**: `web/src/hooks/fork/use-viewport.ts` for the shell and nav only
  (no full responsive migration). Includes **D3**, a tablet 1024x768 Playwright
  project. Flag `viewportLayout`.
- **UI13**: per-device live layout memory and picture-in-picture. Flag
  `liveLayoutMemory`.
- **H3** docs ride along in features4: `web/README.md`, `web/e2e/README.md`,
  `web/patches/README.md`.

Open question for the owner: notification inbox (UI14) and clip sharing (UI11)
could be cut to keep the fork lighter. Default is to build both.

## Remaining work, in order

Two agents at a time.

1. **features1** (`section/features1`, 3 commits). Rebase onto `polish`,
   resolve `FORK.md`, run all gates with `E2E_PORT=4185`, fix anything red,
   merge, push.
2. **features2** (one `wip:` commit on top of `polish` with half-built UI7 and
   UI10). `git reset --soft HEAD~1`, finish both, gates with
   `E2E_PORT=4186`, one commit each, merge, push.
3. **features3** (branch is behind, no work yet). Rebase onto `polish` first,
   then UI8, UI9, UI11 (backend tests in the thin image), gates, merge, push.
4. **features4** (one `wip:` commit with 17 unreviewed files from an aborted
   run, on an old base). `git reset --soft HEAD~1`, review the files and keep
   only what is sound, rebase onto `polish`, finish A1/UI5 + D3, UI13, H3,
   gates, merge, push.
5. **Security triage** (coordinating agent). Dependabot inherits upstream
   rc2's alerts: 221 at first scan, 125 of them in `docs/` and 16 in
   TensorRT/ARM manifests that this fork does not build (now ignored in
   `.github/dependabot.yml`). What ships: `python-multipart` (2 high) in
   `docker/main/requirements-wheels.txt`, and the `/web` lockfile (axios,
   fast-uri, nanoid, postcss, form-data and others; vitest critical is
   dev-only). Merge the grouped `security` PRs for `/web` and `/docker/main`
   once "Fork - Checks" is green on them, add a `SEC` row to `FORK.md`, and
   close any leftover single-package Dependabot PRs they supersede. Patch and
   minor bumps only; for a major, leave the alert open and note it here. On
   the next upstream rebase, take upstream's `package-lock.json` and re-run
   `npm install` rather than hand-merging it.
6. **Closing pass**
   - Rebase `polish` onto the `v0.18.0-rc2` tag (or the newest upstream tag if
     one has shipped) and re-run every gate.
   - Tag `fork/0.18.0-rc2` and push the tag; the Fork - Build image workflow
     publishes `ghcr.io/jtn0123/frigate`. Do not deploy it.
   - Update `fork/GRADE-REPORT.md` with new grades.
   - List the commits marked "candidate" in `FORK.md` that would make good
     upstream PRs, starting with the bug fixes found by the new tests. Do not
     open them; the owner decides whether to send any upstream.
   - Remove the merged section worktrees and their `section/*` branches
     (local and origin).

## Follow-ups (not in the 30)

- About 267 jsx-a11y warnings remain at `warn` level; ratchet down.
- Report items not scheduled: A2, A3, A4, B2, B4, C3, C4, C6, C7, D2, D4, F4,
  F5, H4, I5. C3/C4/C6 are rewrites and stay off the table except as local
  splits when a feature touches the file.
- Live server tweaks were proposed but not approved (Tapo software decode,
  disabling `out_1..4`, camera renames). Leave them alone.
