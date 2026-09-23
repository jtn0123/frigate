# Codebase Grade Report

**Project:** Frigate fork `jtn0123/frigate`
**Audited:** 2026-09-23
**Revision:** `origin/next` at `e667a41a34053703409d6907b3f324dd22339c10`
**Inspection worktree:** `/Volumes/512Flash/frigate-wt/overall-grade-20260923`
**Stack:** Python 3.11, FastAPI, Peewee/SQLite, FFmpeg, multiprocessing/ZMQ, Docker; React, TypeScript, Vite, Vitest and Playwright.
**Scope:** Source, tests, documentation and current CI. Frontend engineering is graded; visual polish and detailed UI/UX are not. Classification changes in another branch or worktree are in progress and are not credited or judged here. This is not a deployed-server or camera-hardware assessment.

## Summary

| ID | Category | Grade | Items |
|----|----------|-------|-------|
| A | Architecture & Design | B | 1 |
| B | Backend Quality | B+ | 2 |
| C | Frontend Quality | B− | 3 |
| D | Testing & Reliability | B | 2 |
| E | Security | B+ | 1 |
| F | Dependencies & Tech Currency | B | 1 |
| G | Performance & Scalability | B− | 2 |
| H | Documentation & Onboarding | B− | 2 |
| I | Developer Experience & Tooling | B | 1 |
| **Overall** | | **B** | **15** |

**Top 5 highest-leverage fixes:** D48, C3, I3, G17, G16.

## Implementation update, 2026-09-23

This worktree now contains implementation passes for the ten requested items.
It has not been pushed, merged, or evaluated by fresh remote CI. Results below
are local and the original B grade remains the grade of the audited `next` revision.

| Item | Current disposition |
|------|---------------------|
| D48 | Local Python and web coverage floors added and passing; the existing Sonar new-code gate was 75.3% on `next` and has not been restored by a new CI run. |
| C3 | Save All moved to a tested module; focused failure, ordering, and restart cases pass. |
| I3 | API request/response definitions and two fork routers added to strict mypy checking; the wider ignored packages remain. |
| G17 | Palette and inbox bodies load on demand; eager gzip measured 385,183 bytes locally versus the prior 413,092-byte CI reading. CI uses another Node version and must confirm the lowered budget. |
| G16 | An indexed-term migration and query were tested, then removed: the synthetic 50,000-row audio-plus-zone median rose from the prior 86.96 ms to 121.43 ms. The [trial artifact](../fork/benchmarks/results/review-summary-index-trial-20260923.json) preserves timings and query plans. No slower production query was kept. The optimization remains open. |
| B2 | Corrected the review-summary schema and typed six common routes. Other JSON routes remain untyped. |
| C21 | Cross-tab inbox storage reconciliation and a regression test added; batching every message and thumbnail fallback remain open. |
| D50 | Runtime viewport skips replaced with project tags; a tablet smoke project added. |
| F5 | Unused `strftime` packages removed and the three remaining patches documented; active Wake Lock and Monaco dependencies retained. |
| H9 | This assessment is indexed from `fork/README.md`; the historical report now identifies resolved `next` items at the top. Automatic stale-status detection remains open. |

The review-summary comparison uses synthetic data in a local test image. The
new trial used five measured runs versus ten in the earlier baseline, so the
numbers are directional. It does not establish production latency.

**Final local verification:** Web lint, TypeScript, generated API types, the
fixture validator, and the production build pass. Vitest passes 683 tests;
web line coverage is 15.76% and clears the new local floors. The final eager
bundle is 385,183 gzip bytes against the 405,000-byte budget. The full browser
suite passed 710 tests with 88 scoped skips on the preceding build; after the
last inbox change and rebuild, all 18 affected desktop, mobile and tablet
tests passed. `make check-py` passes mypy (437 sources), the API-spec check,
1,499 backend tests (one skipped), and the three fork suites (76, 15 and 25
tests). The first `make check-fast` run was red because it began before the
formatting and fixture-path corrections; the corrected gates above were run
separately. Remote Sonar and CI have not been rerun for this unpushed worktree.

The fork has substantial automated coverage, a coherent process architecture, centralized camera authorization for WebSocket broadcasts, and stronger build reproducibility than the prior audit. Its main drag is concentrated in a few large flows, incomplete coverage enforcement, performance headroom, and broad backend type-check exemptions. A B grade describes engineering health, not a claim that the deployed system has been validated.

## Verification and boundaries

- This report inspects the merged `next` revision above. The old untracked `.Codex/grade-report.md` in the primary clone remains untouched. `fork/GRADE-REPORT.md` is a historical audit and has several stale open-item descriptions.
- The latest [Fork - Checks run](https://github.com/jtn0123/frigate/actions/runs/35737114970) for this exact SHA failed. [Sonar](https://github.com/jtn0123/frigate/actions/runs/35737114970/job/106780357978) reports **75.3% new-code coverage against the 80% gate**; its other quality-gate conditions are OK. [Web E2E shard 3](https://github.com/jtn0123/frigate/actions/runs/35737114970/job/106778210940) also failed. The job-log endpoint was rate limited, so the E2E cause is unknown. Other main jobs passed. A red required check is a current release blocker, not proof of a runtime defect.
- No full local test suite, benchmark, live-camera run, or deployment was performed for this audit. `make wt` completed its frontend dependency installation and patch application, but all standard 4190-4199 e2e ports were occupied, so it assigned no default e2e port. This is a sampled engineering audit, not exhaustive defect validation.
- Previously listed A6, B9, D4, E18, F8, F9, H4, H5, H8, I27 and I31 have landed or been addressed on this revision. They are not counted below. In particular, `frigate/test/test_tracked_object_processor.py` now exercises the core tracking processor.
- IDs below retain the existing fork audit IDs where available. A future request to execute an item should compare it with `FORK.md`, `fork/ledger/` and the latest `next` first.

## A — Architecture & Design — B

The multiprocessing/ZMQ layout fits continuous video processing, and `frigate/comms/ws.py:295-310` classifies outbound topics with a fail-closed default. Fork-specific behavior has dedicated modules such as `frigate/api/fork_bulk.py`, and the former monolithic watchdog loop has been split into helpers in `frigate/video/ffmpeg.py`. The largest API routers still combine domain behavior and transport concerns, leaving a substantial review and change surface.

#### A3 — Extract domain work from the largest API routers
- **Where:** `frigate/api/event.py`, `frigate/api/media.py`, `frigate/api/chat.py` (approximately 2,354, 1,887 and 1,584 lines respectively at this revision).
- **What's wrong:** Long route modules combine request handling, data access and business behavior. This is maintenance debt; this audit did not reproduce a route failure.
- **Impact:** Moderate — a change in one behavior requires reviewing large, coupled handlers.
- **Fix:** Extract one actively maintained flow at a time into a backend service, retain route signatures, and add behavior-preserving tests around the extracted flow.
- **Effort:** L
- **Grade lift:** B → B+ after several high-change flows have clear boundaries.

## B — Backend Quality — B+

Fork bulk queries are bounded (`frigate/api/fork_bulk.py:20,51`), blocking review work is moved off the event loop in `frigate/api/review.py`, and the fork audio and diagnostics routes now declare response models. The remaining API contract work is mostly in older upstream routes. The data model and logging rules also leave targeted opportunities for improvement.

#### B2 — Complete response contracts on JSON API routes
- **Where:** `frigate/api/` route decorators and `frigate/api/defs/response/`; a source count found roughly 192 route decorators and 85 `response_model` declarations, which is only a screening count because not every route returns JSON.
- **What's wrong:** Some JSON responses still lack a declared response model. The older audit's exact missing-route count is stale.
- **Impact:** Moderate — clients and schema checks have less protection against response drift.
- **Fix:** Inventory JSON-producing routes, add models to the highest-use endpoints first, regenerate `docs/static/frigate-api.yaml` and generated client types, and test representative response variants.
- **Effort:** L
- **Grade lift:** B+ → B+ initially, with a possible A− after broad contract coverage.

#### B4 — Declare the share expiry index in the model
- **Where:** `frigate/models.py:167-175`, `frigate/events/share_links.py:18-24`.
- **What's wrong:** Expiry pruning filters on `ShareLink.expires_at`, but the index is not declared on the model. A migration-only index can drift from fresh-schema creation.
- **Impact:** Moderate — large share tables may prune more slowly and schema paths can differ.
- **Fix:** Confirm the migration and fresh-schema behavior, declare the appropriate index on the model, and test both schema paths.
- **Effort:** S
- **Grade lift:** B+ → B+ by closing a focused data-layer gap.

## C — Frontend Quality — B−

The React client has strict TypeScript, typed fork API output, meaningful loading/error flows, and extensive unit and browser tests. The remaining concerns are code behavior and maintainability, not an aesthetic verdict. The Settings save path is unusually large, while several newer stateful features have narrower correctness gaps. Detailed visual polish is deferred for the later UI/UX pass.

#### C3 — Isolate and test the Settings save transaction
- **Where:** `web/src/pages/Settings.tsx:910-1205`, `web/src/lib/fork/settings-diff.ts:110-134`.
- **What's wrong:** A roughly 296-line save callback coordinates many settings changes inline, with related diff logic in another module and no focused transaction test.
- **Impact:** Major — saving several settings together has a large regression surface.
- **Fix:** Move the transaction plan and application steps into a tested fork module. Cover partial failures, ordering and repeated saves before simplifying the component.
- **Effort:** L
- **Grade lift:** B− → B as the highest-risk frontend flow becomes testable.

#### C21 — Synchronize inbox state across tabs
- **Where:** `web/src/lib/fork/inbox-store.ts:140`.
- **What's wrong:** The store reloads persisted data but has no storage-event subscription; one tab can overwrite another tab's inbox changes.
- **Impact:** Moderate — users can lose read or dismissal state when multiple tabs are open.
- **Fix:** Listen for relevant storage changes, reconcile records by stable identity, and test concurrent tab-style updates.
- **Effort:** M
- **Grade lift:** B− → B− while removing a user-visible state hazard.

#### C22 — Complete fork string localization
- **Where:** `web/public/locales/en/fork.json`, `web/src/components/fork/BulkActionBar.tsx:96`.
- **What's wrong:** Only the English fork namespace exists and one visible string bypasses `t()`. Other locales request a missing fork namespace.
- **Impact:** Moderate — non-English users see incomplete translations and failed namespace requests.
- **Fix:** Move the literal into i18n, provide a fallback strategy or translated fork namespaces, and run the extraction check.
- **Effort:** M
- **Grade lift:** B− → B− pending broader state-flow work.

## D — Testing & Reliability — B

CI runs lint, type checks, Vitest, backend tests, browser shards, security checks and a Sonar gate (`.github/workflows/fork-checks.yml:90-180`). The merged tracking tests in `frigate/test/test_tracked_object_processor.py:18-23` close an earlier high-priority gap. The current `next` check is nevertheless red for Sonar coverage and one browser shard, and local coverage floors do not independently stop erosion.

#### D48 — Enforce local coverage floors and restore the new-code gate
- **Where:** `web/vite.config.ts:151-161`, `.coveragerc`, `.github/workflows/fork-checks.yml`, [current Sonar job](https://github.com/jtn0123/frigate/actions/runs/35737114970/job/106780357978).
- **What's wrong:** Vitest and Python coverage reports have no local minimum threshold, and the current new-code result is 75.3% against the required 80%.
- **Impact:** Major — a required check blocks integration, and coverage can regress before remote Sonar reports it.
- **Fix:** Identify uncovered changed lines on the current branch, add behavior tests, then set realistic local floors and ratchet them upward. Preserve the 80% new-code gate.
- **Effort:** M
- **Grade lift:** B → B+ once the gate is green and local floors protect it.

#### D50 — Replace runtime viewport skips with explicit test scope
- **Where:** `web/e2e/specs/fork/` (six runtime `test.skip` calls); `web/e2e/playwright.config.ts:58-88`.
- **What's wrong:** Tests decide to skip after launch based on viewport, which can conceal drift in the supported desktop and phone projects. The matrix has no tablet project.
- **Impact:** Moderate — some behavior is exercised less predictably than the test count suggests.
- **Fix:** Move device applicability into named projects or static test declarations, justify remaining skips, and add a tablet smoke project for layout-sensitive flows.
- **Effort:** M
- **Grade lift:** B → B+ with clearer browser coverage.

## E — Security — B+

The WebSocket topic classifier is fail-closed (`frigate/comms/ws.py:295-310`), share token validation is explicit (`frigate/api/fork_share.py:197-206`), and the ffprobe path hardening is now present in `frigate/util/services.py:1023`. The current Sonar quality gate reports its other conditions OK, but a full security audit and deployed configuration review were outside this pass. A durable record of accepted findings and security reporting is still missing.

#### E19 — Keep security triage and reporting instructions in the repo
- **Where:** Repository root (no `SECURITY.md`); `fork/` has no durable finding-triage record.
- **What's wrong:** Decisions about reported vulnerabilities and reporting channels are not documented alongside the code. Historical Sonar alert counts are not used as current findings here.
- **Impact:** Moderate — future maintainers cannot easily distinguish accepted risks from unattended findings.
- **Fix:** Add a concise `SECURITY.md` with private reporting instructions and a fork-owned triage record with finding links, status, rationale and review date.
- **Effort:** S
- **Grade lift:** B+ → B+; this improves accountability rather than proving vulnerability removal.

## F — Dependencies & Tech Currency — B

The production web build now uses a pinned Node 22 image, and runtime Python wheels have per-architecture hash locks (`docker/main/Dockerfile:218-219,366`). `setuptools` and Vitest versions cited as stale in the historical report have already moved. The remaining concern is a small set of old or patched frontend packages whose ongoing need is not explained; major upgrades should be measured, not assumed beneficial.

#### F5 — Audit patched and aging frontend packages
- **Where:** `web/package.json:81,100,154,157-170`, `web/patches/`.
- **What's wrong:** `nosleep.js`, `strftime`, `vite-plugin-monaco-editor`, several overrides and three local patches remain without a patch rationale or retirement criteria.
- **Impact:** Moderate — upgrades and security review take longer when dependency exceptions lack ownership.
- **Fix:** Test whether each package and override is still required, remove unused ones, and document the remaining patch purpose and upstream status in `web/patches/README.md`.
- **Effort:** M
- **Grade lift:** B → B+ after avoidable exceptions are removed.

## G — Performance & Scalability — B−

Backend bulk reads are chunked and the fork has a review-summary benchmark under `fork/benchmarks/`. Those are useful controls. The frontend's eager bundle is close to its budget, and review-summary label filtering still uses an index-unfriendly JSON text expression; actual production impact needs workload measurements.

#### G17 — Reduce the eager web bundle
- **Where:** `fork/bundle-budget.json`, `web/src/` route and feature imports.
- **What's wrong:** The recorded eager gzip bundle is 413,092 bytes against a 414,000-byte budget, leaving 908 bytes of headroom. The budget was raised as features were added.
- **Impact:** Major — subsequent features are likely to exceed the gate or prompt another budget increase, and initial load has little room to improve.
- **Fix:** Profile the current build, defer low-frequency feature modules behind route or interaction boundaries, and lower the budget only after measuring the resulting bundle and page behavior.
- **Effort:** M
- **Grade lift:** B− → B after meaningful load reduction.

#### G16 — Measure and optimize review-summary filters
- **Where:** `frigate/api/review.py:230-251`, `fork/benchmarks/review_summary.py`.
- **What's wrong:** Label and zone filters cast JSON and use `LIKE`, which ordinary indexes cannot serve efficiently. The benchmark exists, but this audit did not establish a production latency regression.
- **Impact:** Moderate — retained-history growth can make filtered summaries increasingly expensive.
- **Fix:** Benchmark realistic large histories and examine SQLite query plans. If the filter is material, introduce an indexed representation and verify parity with current results.
- **Effort:** L
- **Grade lift:** B− → B if measured filtering cost is removed.

## H — Documentation & Onboarding — B−

`fork/ARCHITECTURE.md` and `fork/DEPLOYMENT.md` now explain process flow and deployment/rollback, and `fork/README.md` links to the latter. This is a notable improvement over the older C+ snapshot. The frontend and E2E entry points remain thin, while the tracked historical grade report still labels several landed items as pending.

#### H9 — Reconcile the tracked audit with merged code
- **Where:** `fork/GRADE-REPORT.md:1-54` and its A6, B9, D4, E18, F8, F9, H4, H5, H8, I27 and I31 entries.
- **What's wrong:** The tracked report describes several merged changes as only local or pending, which can misdirect future work.
- **Impact:** Moderate — stale priority lists waste audit and implementation time.
- **Fix:** Update item status from `next` and ledger evidence, date the snapshot, and link this newer assessment without reusing shipped IDs.
- **Effort:** S
- **Grade lift:** B− → B as the project guide becomes trustworthy.

#### H3 — Explain the frontend and browser-test workflow
- **Where:** `web/README.md:1-25`; missing `web/e2e/README.md` and `web/patches/README.md`.
- **What's wrong:** The web README is a short upstream stub and does not explain this fork's generated types, mock data, e2e ports, or dependency patches.
- **Impact:** Moderate — new contributors must reverse-engineer routine commands and generated artifacts.
- **Fix:** Add concise instructions and links for web setup, targeted tests, fixture generation, i18n extraction and patch ownership.
- **Effort:** S
- **Grade lift:** B− → B with more reliable onboarding.

## I — Developer Experience & Tooling — B

`make wt` creates isolated branches and ports, `make check` mirrors a broad CI gate, and `.pre-commit-config.yaml:7-25` now covers fork Python and shell/workflow tooling. The main remaining developer-safety gap is the broad mypy exclusion of backend packages. The red current CI run limits the practical value of otherwise comprehensive gates until its two failed jobs are resolved.

#### I3 — Continue the backend mypy ratchet
- **Where:** `frigate/mypy.ini:33-55,65+`.
- **What's wrong:** `ignore_errors = true` still covers whole packages including API, configuration, detectors, embeddings, PTZ, utilities and video; selected modules opt back in, but substantial new code remains unchecked.
- **Impact:** Major — type mistakes in high-change backend paths can escape local checks.
- **Fix:** Enable one manageable module group at a time, fix real errors, add each group to the ratchet, and retain the CI check against regression.
- **Effort:** L
- **Grade lift:** B → B+ after meaningful high-change package coverage.
