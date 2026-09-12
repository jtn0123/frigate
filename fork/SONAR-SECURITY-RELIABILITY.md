# Sonar security and reliability batch

Base: `next` at `e5d6c55a82086488f1bbc61c6d174070400caa34`.
Branch: `fix/sonar-security-reliability`.

## Count

- 33 fixes in the batch: 30 Sonar findings plus three additional recording-probe defects.
- 30 existing findings addressed in source: 28 log-injection sites and two
  returns from finally blocks that suppressed shutdown exceptions.
- Reolink SSRF remediation is deferred in full. The partial host/redirect
  change was removed after review confirmed it did not resolve destination
  trust; there are no endpoint validation or request changes in the final PR.
- Sonar-confirmed closures: pending a scan of these changes. The published
  baseline remains 2,227 open findings; do not subtract this batch yet.

## Behavior and scope

Log arguments use lazy repr formatting to escape CR/LF and other control
characters in strings. Camera names, remote errors, MQTT topics, model names,
and job IDs can no longer add lines through these 28 messages. Camera/config
validation limits exposure at some sites; these are source hardening counts,
not 28 independently proven remote exploits. This does not sanitize every log
or traceback in the application.

The GPU helpers still return empty or partial results on ordinary failures,
but now propagate KeyboardInterrupt and SystemExit instead of swallowing them.

The Reolink endpoint intentionally connects to admin-selected hosts, including
private cameras. A partial host-format and redirect change still left this
broader SSRF finding unresolved. The final PR defers that entire change until
an allowed-destinations policy is designed, and does not count it as a fix.

## Reviewed without counting a fix

- `python:S2068`, frigate/const.py: the flagged value is the password hashing
  algorithm identifier `pbkdf2_sha256`, not a credential.
- `pythonsecurity:S8701`, testing-scripts/analyze_recording_keyframes.py:
  subprocess.run uses an argument list without a shell. The local operator
  selects the executable. No remote command-execution path was established.
- `pythonbugs:S2259`, frigate/timeline.py: the queue consumer already rejects
  non-start events without prior data before calling handle_object_detection.
  No reachable failure was established; no speculative guard added.

## Validation

- Full backend suite in the Python 3.11 Docker test environment: 1,075 tests passed.
- 12 new regression tests passed; running them against the original source
  reproduced 21 failing assertions/subtests.
- Mypy passed on 360 source files.
- Pinned Ruff 0.15.20 lint and formatting passed on all changed Python files.
- API spec regenerated, matched the committed spec, and passed the drift check.
- git diff --check passed. No live camera or deployment validation performed.

Regression tests cover malicious host suffixes,
valid camera hosts/ports, refused redirects, injected log line breaks in all
five affected logging modules, preserved job cancellation/cleanup, and GPU
shutdown propagation versus ordinary failures. External services are mocked.

## Addressed source findings

| Sonar issue | Rule | Original file:line |
|---|---|---|
| AaCOHyZo9tFduPng090f | pythonsecurity:S5145 | frigate/api/camera.py:152 |
| AaCOHyZo9tFduPng090h | pythonsecurity:S5145 | frigate/api/camera.py:173 |
| AaCOHyZo9tFduPng090g | pythonsecurity:S5145 | frigate/api/camera.py:193 |
| AaCOHyZo9tFduPng090i | pythonsecurity:S5145 | frigate/api/camera.py:228 |
| AaCOHyZo9tFduPng090d | pythonsecurity:S5145 | frigate/api/camera.py:1127 |
| AaCOHyZo9tFduPng090j | pythonsecurity:S5145 | frigate/api/camera.py:1133 |
| AaCOHyZo9tFduPng090e | pythonsecurity:S5145 | frigate/api/camera.py:1139 |
| AaCOHyc99tFduPng091y | pythonsecurity:S5145 | frigate/api/classification.py:1332 |
| AaCOHyc99tFduPng091x | pythonsecurity:S5145 | frigate/api/classification.py:1340 |
| AaCOHyth9tFduPng097t | pythonsecurity:S5145 | frigate/comms/dispatcher.py:386 |
| AaCOHyk99tFduPng094k | pythonsecurity:S5145 | frigate/jobs/motion_search.py:943 |
| AaCOHyk99tFduPng094j | pythonsecurity:S5145 | frigate/jobs/motion_search.py:950 |
| AaCOHyuJ9tFduPng098I | pythonsecurity:S5145 | frigate/ptz/onvif.py:150 |
| AaCOHyuJ9tFduPng098U | pythonsecurity:S5145 | frigate/ptz/onvif.py:204 |
| AaCOHyuJ9tFduPng098O | pythonsecurity:S5145 | frigate/ptz/onvif.py:213 |
| AaCOHyuJ9tFduPng098V | pythonsecurity:S5145 | frigate/ptz/onvif.py:262 |
| AaCOHyuJ9tFduPng098J | pythonsecurity:S5145 | frigate/ptz/onvif.py:274 |
| AaCOHyuJ9tFduPng098T | pythonsecurity:S5145 | frigate/ptz/onvif.py:288 |
| AaCOHyuJ9tFduPng098G | pythonsecurity:S5145 | frigate/ptz/onvif.py:377 |
| AaCOHyuJ9tFduPng098F | pythonsecurity:S5145 | frigate/ptz/onvif.py:420 |
| AaCOHyuJ9tFduPng098R | pythonsecurity:S5145 | frigate/ptz/onvif.py:455 |
| AaCOHyuJ9tFduPng098W | pythonsecurity:S5145 | frigate/ptz/onvif.py:491 |
| AaCOHyuJ9tFduPng098P | pythonsecurity:S5145 | frigate/ptz/onvif.py:506 |
| AaCOHyuJ9tFduPng098K | pythonsecurity:S5145 | frigate/ptz/onvif.py:515 |
| AaCOHyuJ9tFduPng098S | pythonsecurity:S5145 | frigate/ptz/onvif.py:521 |
| AaCOHyuJ9tFduPng098Q | pythonsecurity:S5145 | frigate/ptz/onvif.py:920 |
| AaCOHyuJ9tFduPng098H | pythonsecurity:S5145 | frigate/ptz/onvif.py:933 |
| AaCOHyuJ9tFduPng098N | pythonsecurity:S5145 | frigate/ptz/onvif.py:953 |
| AaCOHyo89tFduPng096b | python:S1143 | frigate/util/services.py:880 |
| AaCOHyo89tFduPng096e | python:S1143 | frigate/util/services.py:1203 |

Deferred without source changes: `AaCOHyZo9tFduPng090b` (`pythonsecurity:S5144`), frigate/api/camera.py:498.

## Recording diagnostic follow-up

Three additional defects, counted separately from Sonar issue IDs:

1. Failed ffprobe executions could classify partial stdout as OK. A nonzero
   return code now returns unknown instead of reporting recording suitability.
2. Nonfinite packet timestamps (NaN/infinity) could corrupt the classification
   and produce values that JSON cannot serialize. The parser skips them.
3. Timed-out or cancelled probes were not reliably terminated and reaped.
   Cleanup now kills a still-running process, handles an exit race, and drains
   its pipes before returning or propagating cancellation.

Four additional regression methods and a strengthened timeout test reproduced
four failures and one error before the follow-up; all now pass. The combined
focused run passed 27 tests. Final expanded validation: 1,079 backend tests passed, mypy passed on 360
files, and pinned Ruff checks passed. These results supersede the initial
1,075-test run above.

## PR 35 review follow-up

Seven logging sites use explicit CR/LF replacement after repr formatting so
both runtime formatting and the analyzer recognize their single-line boundary.
The cancellation exception test constructs its mock before assertRaises.
Three tests specific to the deferred Reolink change were removed with that
change. Final regression coverage contains 13 new methods plus the strengthened
timeout test. Focused follow-up: 26 tests passed, including earlier ONVIF logging
regressions. Expanded backend gates are rerunning on the final source.

PR: https://github.com/jtn0123/frigate/pull/35
