# Small and medium engineering follow-ups, 2026-09-21

Local worktree: `section/engineering-followups-20260921`, based on
`origin/next` at `d441c9fbb03dbda9fdc981e13f6c6bc4b68cfeff`. This branch also carries forward the prior D4/I3/F8/F9 fixes
and I27 documentation from `section/core-reliability-20260920`; that worktree
was preserved. No application deployment or UI redesign was performed.

| Item | Result |
|---|---|
| H5 | Owner deployment and rollback guide, with digest pins and matched database/configuration restore |
| E18 | Explicit ffprobe `-i` input boundary, preserved through RTSP retry |
| B9 | Audio/diagnostic response models, generated API schema/client, generated types in callers |
| A6 | Smaller watchdog checks with restart/backoff and recording grace regression coverage |
| I31 | Ruff covers fork Python roots; pinned actionlint and ShellCheck cover fork workflows/scripts |
| G11 | Reproducible review-summary benchmark and invalidation analysis; caching remains open pending live evidence |
| H8 | Single demo/test/CI runtime base, base-change CI regression, archived historical plans and clarified workflow rules |
| H4 | Runtime process, frame-lifetime and messaging architecture guide |

The frontend edits for B9 only replace handwritten response types with generated
types. The typed GET helper currently supports fixed paths; the parameterized
audio route keeps its existing SWR key, and diagnostics remains a cancellable
POST. Request behavior and rendered UI are preserved.

## Validation

- E18 fail-before: three test methods produced five failures with the bare
  input argument; all pass after the explicit input fix.
- API/input focused run: 34 tests passed, including actual FastAPI response
  serialization and malformed audio data fallback.
- Watchdog/restart/fallback focused run: 64 tests passed. The full-loop tests
  bind the real extracted helpers rather than replacing them with mocks.
- Full backend suite: 1,440 tests passed, one skipped, in 82.257 seconds.
- Audio trial, its benchmarks and monitoring: 76 + 15 + 25 tests passed.
- Backend mypy: no issues in 429 source files.
- Web application and e2e TypeScript, generated API drift check and fork type
  checks passed. Two focused Vitest files passed all 10 tests.
- Shared-base CI selector regression: seven tests passed. Compose resolves
  the same `ghcr.io/blakeblackshear/frigate:0.18.0` base as the Makefile.
- Pre-commit configuration, fork actionlint and fork ShellCheck passed. New
  hooks deliberately leave upstream workflow/shell lint debt outside scope.
- Ledger validation passed for all 58 row files. New documentation links were
  checked against source paths; deployment steps were not executed.

The backend tests used the repository's Python 3.11 runtime test image with
current source copied into a disposable container. Test databases were on
RAM-backed storage to avoid development-VM filesystem sync latency. This is
unit/integration evidence, not proof of live camera, GPU or recording behavior.

The review-summary benchmark used synthetic 5,000/50,000-row histories on
RAM-backed SQLite. See [results and limitations](benchmarks/REVIEW-SUMMARY.md).
It does not demonstrate a production speedup. A newest-row timestamp cannot
safely invalidate per-user review summaries, so no cache was introduced.

## Standard gate result

`make check-fast` passed ESLint/fixture lint, app/e2e types, generated API
checks, the type ratchet, changed Vitest tests, i18n, Ruff, fork mypy and
gitleaks. Its newly built backend image passed mypy and the API schema check.
The host script lane initially lacked `defusedxml` in the isolated Python
environment; installing it there and rerunning the exact discovery command
passed all 157 script tests.

The standard gate is **not recorded as green**: its duplicate backend suite
on the development VM disk was intentionally stopped after the complete suite
above had passed with RAM-backed test databases. No failure in that interrupted
run is presented as a product defect or a passing result. The passing 1,440 +
116 tests above are the backend validation evidence. The successful rerun of
the script lane is separate from the original gate exit status.

At the initial implementation handoff, full local and remote validation was
still pending. The fast gate correctly skipped the bundle build and full
Playwright suite because no e2e files changed. No deployment was performed.
The subsequent PR validation below supersedes that earlier limitation.


## PR preparation

The summary benchmark now has three backend tests covering migrated indexes,
restricted-camera counts, original model bindings, connection cleanup after
failure, and CLI validation. The benchmark is included in the Docker test
image, Ruff scope and coverage source list. The added tests exposed migration
030 changing global model bindings; the benchmark now scopes migration and
queries together and restores the bindings on exit.

The full `make check` subsequently passed all lanes, including 679 Playwright
cases (95 platform/tag skips), production build/bundle budget, backend tests,
API drift checks, mypy, lint, i18n, type ratchet, tooling tests and secret scan.
The Docker backend lane took 831 seconds on the development VM disk. The
additional benchmark tests were checked separately, followed by a complete
final-source backend run: 1,443 tests, one skipped, in 84.543 seconds with
RAM-backed test databases. Runtime-lock tests also passed (10 tests).

GitHub exposed a setup error in the first run: copying a comment line from the
shared runtime file into GITHUB_ENV is invalid. The export now selects only
the runtime assignment; a regression test fails on the old command and passes
on the corrected command. actionlint also passes on the corrected workflow.

Current remote checks, Sonar and review disposition are recorded on
[PR #93](https://github.com/jtn0123/frigate/pull/93). Local results do not
substitute for the checks on its final head revision.
