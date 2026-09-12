# Sonar coverage and quality gate

`Fork - Checks` generates Python XML and frontend LCOV coverage for the same
revision on every run. Lint and browser checks retain their change filters.
The scan downloads both artifacts, rejects empty reports or unresolved source
paths, then waits up to ten minutes for Sonar's quality gate. A failed gate
fails `Checks passed`. No token or failed tests means no successful scan.

The scanner uses the full repository as its source scope, with tests classified
separately. Generated declarations and version metadata are excluded from
coverage. Untested production code remains visible. Frontend coverage comes
from Vitest; Playwright browser tests do not contribute to this report.

Fork pull requests do not receive the Sonar secret and skip the scanner.
Their tests still run. Never change this to `pull_request_target` with untrusted
source checkout. A trusted branch or post-merge scan is needed for their Sonar
results. Require `Checks passed` in the GitHub branch rules for merge enforcement.

## Activation

1. Add a Sonar analysis token as the GitHub Actions repository secret
   `SONAR_TOKEN` in `jtn0123/frigate`. Use the narrowest analysis permission
   available and an appropriate expiry. Do not put the token in source or chat.
2. Publish this workflow on a branch and open a pull request to `next`.
3. Immediately before running the CI scan, disable Automatic Analysis in the
   Sonar project's Administration > Analysis method. CI and automatic analysis
   cannot both analyze the project. Keep automatic scans enabled until the
   token and CI workflow are ready, to avoid a monitoring gap.
4. Check the scan's coverage-import messages and quality gate, then merge.
   Confirm the resulting `next` scan has coverage and a computed gate.

Project: `jtn0123_frigate`, organization: `jtn0123ismysonar`.
The project new-code definition was set to 30 days on September 12, 2026.
The existing Sonar way gate requires A ratings, 100% reviewed new security
hotspots, at least 80% new-code coverage, and at most 3% new-code duplication.
Sonar's existing small-change exemption applies below 20 new lines.
PR analysis compares against its target; branch analysis uses the new-code
period. Older coverage debt is reported separately, not hidden by changing
thresholds. The first computed branch gate may fail on recent coverage debt.

## Local verification

- Backend: 1,097 tests passed under coverage.py 7.8.0 with branch measurement;
  39.17% line coverage across configured Python sources.
- Frontend: 258 tests passed with V8 coverage; 8.09% line coverage.
- Report validator resolved all 309 Python and 508 frontend file entries.
- Workflow validation uses actionlint; report tests cover path normalization,
  repeated processing, missing/external files, empty reports, and XML entities.

These are local tool percentages, not a confirmed Sonar combined percentage.
Server import and CI gate enforcement still require activation and a live run.
