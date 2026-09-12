# Sonar fix tracker

Started September 12, 2026 from `origin/next` at `54e9c1f39`.
Work branch: `fix/sonar-priority`.

## Running totals

- Fix batches implemented and passing focused checks: **7**
- Previously observed Sonar findings addressed in source: **415**
- Current request: **300 additional findings addressed**
- Sonar findings confirmed closed by a new scan: **0**
- Latest backend validation: **passed, 1,063 tests in 284.577 seconds** (PR follow-up)
- Round 3 frontend validation: passed; subsequent warning cleanup tracked separately
- Delivery: [PR 34](https://github.com/jtn0123/frigate/pull/34), targeting `next`; no merge or deployment

The source count maps to findings observed in the initial Sonar review. It is
not a reduction measured by Sonar. Multiple warnings can share one fix; extra
hardening changes without a captured finding are not added to that count.

## Round 3 validation

The [round 3 ledger](SONAR-ROUND3-FIXES.md) links 300 distinct additional Sonar
issues, numbered 116-415. This round changes frontend code only.

- 290 read-only component-props contracts in 197 files, matched to Sonar source
  ranges and verified after editing.
- Emitted JavaScript was identical immediately after all type-only edits.
  After formatting, JavaScript structure is unchanged in the 192 files outside
  the context batch. The remaining five props files also have context fixes.
- 10 memoized context values in nine files. Nine context regression tests
  failed before the changes; all ten tests pass afterward. The mobile-page test
  is a behavior guard rather than a reproduced render-count failure.
- Full frontend unit suite: 236 tests passed across 20 files.
- TypeScript checks passed, including app, E2E and fork type checks.
- ESLint and E2E spec lint passed with 0 errors and 85 warnings.
- Production build and bundle budget passed (364,977 / 370,844 gzip bytes).
- Browser checks: 30 passed, 11 skipped.

Subsequent [warning cleanup](SONAR-WARNING-CLEANUP.md) is tracked separately.
Its intentional runtime edits follow the type-only JavaScript verification above.

The props contracts are shallow and do not freeze nested objects or arrays.
They strengthen compile-time API contracts without adding runtime behavior.

## Round 2 validation

The public Sonar API returned 2,703 unique open issues on `next`. The
[round 2 ledger](SONAR-ROUND2-FIXES.md) links the 100 distinct additional issue
IDs and their changed source locations.

- Focused error-recovery and watchdog lifecycle tests: **4 tests passed**.
- Baseline failures demonstrated missing traceback information for database,
  filesystem and download failures, and a watchdog still running after shutdown.
- AST verification: all 99 logging changes preserve log arguments, surrounding
  control flow and return behavior. Each changed call is inside an exception
  handler. Existing manual traceback logs and authentication logs were excluded.
- Ruff lint/format: passed for all 39 changed/new Python files across both rounds.
- Workflow validation and `git diff --check`: passed.
- Full unittest: **1,059 tests passed in 264.223 seconds**.
- mypy: **no issues in 357 source files**.
- API-spec drift check: passed.
- All 356 worktree Python files matched their container copies by hash; the
  additional container file was the generated `frigate/version.py`.
- The ledger contains exactly 100 distinct additional issue IDs, numbered
  consecutively from 16 through 115.

## Round 1 validation

- Full Python unittest suite in an isolated local Docker test container:
  **1,055 tests passed** (including eight camera/Whisper tests).
- mypy: **no issues in 355 source files**.
- Ruff lint and formatting: passed for all five changed/new Python files.
- API specification regenerated with no diff; `--check` passed.
- Both changed workflows passed actionlint with shellcheck and pyflakes disabled.
- Workflow comparison verified that only action version references changed and
  every external action in those two files uses a full commit SHA.
- `git diff --check`: passed.
- All 354 Python files in the worktree matched their container copies by hash;
  the only additional container source was the generated `frigate/version.py`.

The Docker tests use mocked cameras/model libraries. No live camera deletion,
GPU inference, image publication or production deployment was performed.

## Completed batches

| Batch | Priority | Change | Findings | Cumulative |
|---|---|---|---:|---:|
| S1 | P1 | Move camera deletion's locked config transaction off the event loop | 3 | 3 |
| S2 | P1 | Pin CI and release actions to verified commits | 11 | 14 |
| S4 | P2 | Align Whisper loader signatures and forward timestamped device selection | 1 | 15 |
| S8 | Sonar High maintainability | Preserve traceback diagnostics in caught-error paths | 99 | 114 |
| S9 | Runtime lifecycle | Retain replay watchdog and cancel/await it during API shutdown | 1 | 115 |
| S10 | Sonar Low maintainability | Mark component props read-only | 290 | 405 |
| S11 | Sonar Medium maintainability | Stabilize React context values and callbacks | 10 | 415 |

### Round 2 details

S8 adds traceback information to 99 existing error logs across 33 backend files.
This helps diagnose recording/database cleanup, detector initialization and
inference, ONVIF, transcription, model downloads, file locking and API failures.
It preserves existing log messages and recovery behavior. These are 99 Sonar
diagnostic findings, not a claim of 99 independent functional failures.

S9 stores the replay watchdog task in application state and explicitly cancels
and awaits it on shutdown. The regression test proves both that it runs during
the application's lifetime and that shutdown waits for its cleanup.

The additional request is complete with the full backend gate passing. Remote
closure remains zero pending delivery and Sonar analysis. Details and IDs are in
[SONAR-ROUND2-FIXES.md](SONAR-ROUND2-FIXES.md).

### S1: camera deletion

The event-loop regression test failed before the fix and passes afterward.
The worker retains the lock across file I/O, config validation, runtime swaps
and publication. Camera existence is checked under the lock so competing
deletion requests cannot both proceed. The test suite also covers rollback,
lock timeout, dispatcher synchronization and concurrent duplicate deletion.

Observed findings: `frigate/api/camera.py` original lines 1198, 1205, 1231.
The first issue key is `AaCOHyZo9tFduPng090V`; the other two keys were not
captured by the browser snapshot. All five synchronous file-open sites and
the blocking file lock were moved together; only the three observed findings
are counted.

### S2: build actions

Pinned 18 external action references in `.github/workflows/ci.yml` and
`.github/workflows/release.yml`. Eleven correspond to captured High findings;
seven additional checkout references are hardened without inflating the count.
Existing pinned login actions and local composite action references stay intact.

All five version tags were resolved directly against the owning GitHub repo:

| Action | Version | Commit |
|---|---|---|
| actions/checkout | v6 | d23441a48e516b6c34aea4fa41551a30e30af803 |
| docker/build-push-action | v7 | 53b7df96c91f9c12dcc8a07bcb9ccacbed38856a |
| docker/bake-action | v7 | d3418bd7d0e9324001bca92fa8ba175ea7e6dc9b |
| ASzc/change-string-case-action | v6 | d0603cd0a7dd490be678164909f65c7737470a7f |
| int128/docker-manifest-create-action | v2 | 6edb43463bd4878b8cee224ca274378a3635d78f |

Validation: `actionlint -shellcheck='' -pyflakes=''` passes for both workflows.
This validates workflow structure, not a live build or release. Version comments
are retained. Existing Dependabot security-update configuration is unchanged;
routine version-update PRs are already disabled by repository policy.

Issue keys (prefix `AaCOH0Pc9tFduPng`, except the release issue):
`0-Zv`, `0-Zw`, `0-Zx`, `0-Zy`, `0-Zz`, `0-Z0`, `0-Z1`, `0-Z2`,
`0-Z3`, `0-Z4`; release: `AaCOH0PT9tFduPng0-Zu`.

### S4: Whisper constructors

Both MLX and timestamped constructor tests reproduced TypeError before the
change. Their loaders and the base declaration now accept the four arguments
the shared constructor supplies. Timestamped forwards the device to Whisper;
MLX documents its independent device management. Faster Whisper CPU/CUDA
configuration tests also pass.

Issue: `AaCOHyga9tFduPng093b`.
Tests mock model libraries; they do not prove physical GPU inference or model
downloads. The active Frigate Faster Whisper backend is not claimed to have
suffered this constructor failure.

## Next queue

1. S3 (P1 review): validate writable runtime paths against actual ownership and
   attacker access before changing or dismissing them.
2. S5 (P2 review): validate developer-script executable/path trust boundaries.
3. S6 (P3 triage): verify likely analyzer false positives in Peewee count,
   shared-memory initialization and displayed/mock temporary paths.
4. S7 (P3): lower-risk shell and sorting maintenance.

Do not count accepted risks or false-positive dispositions as code fixes.
Update the confirmed-closed total only after inspecting a scan of the delivered
revision. Sonar was signed out during initial review; no remote issue metadata
has been changed.
