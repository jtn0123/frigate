# Sonar coverage and quality gate

`Fork - Checks` generates Python XML and frontend LCOV coverage for the same
revision on every run. Lint and browser checks retain their change filters.
The scan downloads both artifacts, rejects empty reports or unresolved source
paths, then waits up to ten minutes for Sonar's quality gate. A failed gate
fails `Checks passed`. No token or failed tests means no successful scan.

The scanner uses the full repository as its source scope, with tests classified
separately. Generated declarations and version metadata are excluded from
coverage. Untested production code remains visible. Frontend coverage is
Vitest's report merged with the coverage the Playwright suite measures in the
browser (`web/scripts/fork/merge-browser-coverage.mjs`, run by the `sonar` job
when the E2E job ran). The browser share is the larger one: without it the
new-code coverage on `next` reads 58.5%, with it 83.5% (2026-09-17).

The Free plan scans `next` and same-repository PRs targeting `next`. Release
branch `main` and `sync/**` pushes retain their other checks without attempting
unsupported Sonar branch analysis.

Fork pull requests do not receive the Sonar secret and skip the scanner.
Their tests still run. Never change this to `pull_request_target` with untrusted
source checkout. A trusted branch or post-merge scan is needed for their Sonar
results. `next` now requires `Checks passed` through an active GitHub ruleset.

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

## Green pull requests, red `next` (I28, 2026-09-17)

Six of twelve pushes to `next` failed the gate between 2026-09-14 and 09-17
although every pull request had passed it. The scanner log only says
`QUALITY GATE STATUS: FAILED`, so the conditions below come from Sonar's
public API (`api/measures/search_history`, metric `quality_gate_details`, and
`api/qualitygates/project_status`, both with `branch=next`).

| Push to `next` | Failed condition | Cause |
|----|----|----|
| 2026-09-12 to 09-13, PR 39 to 42 (before the twelve) | `new_coverage` 77.7 (needs 80) | The first computed branch gates: code merged between the first analysis (09-11) and the gate's activation (09-12) never passed a pull request gate. E2E ran. PR 45 added the missing tests |
| 2026-09-14, PR 54 | not kept (Sonar keeps one analysis a day) | Unknown; the audio companion job failed in the same run |
| 2026-09-15 04:56, "Merge validated build performance improvements into next" | `new_security_rating` 3 (C) | Pushed as a merge, not a pull request, so no pull request analysis ever saw its twelve security findings (I26) |
| 2026-09-15 to 09-17, PR 59, 60, 62 | `new_security_rating` 3 (C) | The same findings, still on the branch; none of these pull requests touched those lines |
| 2026-09-17 04:31, PR 63 | `new_security_rating` 3 and `new_coverage` 58.5 | As above, plus a Python-only push skipped the E2E jobs, so the web code counted as untested |
| 2026-09-17 05:33, PR 64 | none: green, `new_coverage` 83.5 | I26 closed the findings; E2E ran |

Why the two gates disagree: pull request analysis judges only the lines the
pull request changes. Branch analysis judges every line inside the new-code
period (30 days; at the moment everything since the first analysis on
2026-09-11), on every push. So anything that reaches `next` without passing a
pull request gate, or a scan whose coverage report is incomplete, turns the
branch red, and it stays red for every later push, however clean, until the
cause itself is fixed. Pull requests that each reach 80% cannot add up to
less, so the period's length was not the cause of any of these failures; what
reached the branch ungated was (code from before the gate existed, a merge
pushed directly, and the under-20-lines exemption, which is small).

Decision:

- Keep the branch gate blocking, and keep the 30-day period. `make promote`
  releases whatever is on `next`, so findings that are on `next` should stop
  it. A report-only branch scan would have let the twelve findings ship.
- The reference-branch definition is not an option here: SonarQube Cloud
  offers previous version, number of days, specific version and specific date
  only, and the Free plan analyzes no branch but `next`, so there is no
  analyzed `main` to refer to. `sonar.newCode.referenceBranch` is a SonarQube
  Server setting.
- Repo-side fix 1: every push to `next` runs the web jobs
  (`fork/scripts/ci-changes.sh`), so the branch scan always has browser
  coverage. Since I26 that was true for Python pushes only; a docs-only or
  workflow-only push still scanned with Vitest coverage alone. Pull requests
  keep the change filter, because they are judged on their own lines.
- Repo-side fix 2: when the scan step fails, the next step prints each failed
  condition as an error annotation, so coverage (an incomplete report) and a
  rating (a real finding) can be told apart without opening Sonar.
- Practice: everything lands on `next` through a pull request, including
  merges of long-running work, so its lines pass the pull request gate first.
  The ruleset already requires `Checks passed`; the 2026-09-15 merge went in
  through the owner's bypass.

Optional, owner only (needs Sonar project admin; not needed for the fixes
above): to make the branch gate mean "since the last release", not "the
last 30 days", set Administration > New Code to "Previous version" and have
the scan pass `-Dsonar.projectVersion=<latest fork/* tag>`. Not done, because
the period did not cause these failures and a reset at every promote would
forgive whatever debt was open at that moment.

When `next` is red: read the annotations of the failed `sonar` job. For
`new_coverage`, check that the three E2E shards ran and uploaded
`browser-coverage-*`. For a rating or hotspot condition, open
`https://sonarcloud.io/project/issues?id=jtn0123_frigate&branch=next&inNewCodePeriod=true&resolved=false`,
fix the finding in a pull request, and the push that merges it turns the
branch green again.

## Local verification

- Backend: 1,097 tests passed under coverage.py 7.8.0 with branch measurement;
  39.17% line coverage across configured Python sources.
- Frontend: 258 tests passed with V8 coverage; 8.09% line coverage.
- Report validator resolved all 309 Python and 508 frontend file entries.
- Workflow validation uses actionlint; report tests cover path normalization,
  repeated processing, missing/external files, empty reports, and XML entities.

These are local tool percentages, not a confirmed Sonar combined percentage.
Server import and CI gate enforcement still require activation and a live run.

## Activation verification

PR 39 CI scan at cb0e3ab30 imported both reports successfully and passed the
quality gate with 82.9% new-code coverage, 0% new duplication, and A ratings.
No coverage conditions were ignored. The scanner validated 312 Python and
508 frontend report entries. The test image now runs as UID/GID 1000.
The Sonar token was stored in GitHub Actions on September 12 and expires
October 11, 2026 (as displayed by Sonar). Rotate it before that date.
Automatic Analysis is off; ongoing next scans start once this workflow merges.
