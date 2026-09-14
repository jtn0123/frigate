# Recording regression protection

Second pass of the behavior audit, based on merged `next` at
`3d2ba54623073977aa8f34649704732641cf3122`.

## Scope and user impact

This batch addresses original audit items 1, 2, 3, 4, 5, and 12. It does not
claim that all 20 findings are fixed or covered by regression tests.

| Audit item | What went wrong | Protection added |
| --- | --- | --- |
| 1 | Cleanup could delete a new recording before its database entry arrived | One-hour grace period, plus another age/database check immediately before deletion. Force does not bypass the grace period. |
| 2 | A temporary converter-start failure deleted the original cached footage | Keep the original for retry; write to a temporary destination and publish only complete output. |
| 3 | Verbose or hung FFmpeg could stall the recording batch | Drain stderr while waiting; enforce a 60-second deadline and kill/reap a timed-out or cancelled process. |
| 4 | Stop reported success even when the server rejected it | Await success, retain the event ID on failure, show the error, and allow retry. |
| 5 | Multiple clicks could create recording events while the first request was pending | Immediate ref guard and disabled controls while creation or stopping is pending. |
| 12 | Recording cleanup duplicated page one and skipped the final page | One-based, consistently ordered database pagination. |

The second pass also verified two related failure paths: a failed conversion left
an incomplete final file that blocked retries, and failure to remove the cached
copy prevented registration of a successfully converted recording. Temporary
output is now cleaned up, and cache-removal failure no longer discards successful
recording metadata.

## Permanent tests and red/green evidence

Tests are normal repository tests, discovered by the existing backend unittest
and frontend Playwright CI jobs. No workflow exclusions or test skips were added.
The WebP snapshot mock now matches the requests made by the actual player; a
fixture 403 is not treated as evidence of an application failure.

| Test file | Tests | Original code | Fixed code |
| --- | ---: | --- | --- |
| `frigate/test/test_recording_sync_safety.py` | 7 | 5 fail, 2 pass | 7 pass |
| `frigate/test/test_recording_write_safety.py` | 6 | 5 fail/error, 1 pass | 6 pass |
| `web/e2e/specs/live.spec.ts` (Manual recording confirmation) | 2 | 2 fail | 2 pass |
| `frigate/test/test_http_fixture_lifecycle.py` | 1 | 1 fail | 1 pass |

The original-code run uses production imports and methods, not copies of the
implementation. Database tests use isolated SQLite and temporary media files.
Conversion tests start real child processes; the success-path test generates a
video with FFmpeg, converts it, and decodes a frame from the final output.
Browser tests click the real controls with mocked API outcomes, including a
failed stop followed by a successful retry. Unexpected browser errors are checked.

Run the targeted tests:

```sh
python3 -u -m unittest frigate.test.test_recording_sync_safety frigate.test.test_recording_write_safety frigate.test.test_http_fixture_lifecycle
cd web
npm run e2e:build
E2E_STRICT_ERRORS=1 npx playwright test --config e2e/playwright.config.ts e2e/specs/live.spec.ts --project=desktop --grep "Manual recording confirmation"
```

The backend tests require the project Linux test image and its FFmpeg installation,
as does the normal backend CI environment. The new browser regressions cover the
desktop control; existing Live-page tests additionally exercise mobile navigation.

## Remaining limits and second-pass disposition

The grace period is a conservative settling window, not a transaction shared by
the filesystem and database. A database-publication outage longer than one hour
can still require operator recovery. The final recheck narrows races but is not
an atomic cross-process lock. This batch does not redesign recording publication.
No real camera, deployment, or accelerator device was used in validation.

Audit items 6-11 and 13-20 remain open. Their original source evidence and isolated
reproductions are not permanent regression coverage. In particular, the chat
helper camera-filter bugs must be addressed before broadening chat access; the
production global-admin safeguard still limits reachability. The numerical,
timezone, microphone, player-request, and statistics risks retain the conditional
qualifications in the first report.

The second pass also observed duplicate manual-recording toast containers in the
Live page. The regression asserts the visible camera-page message, and this
presentation issue remains separate from server confirmation correctness.


## Test-fixture failure found by the full suite

The first full backend run executed 1,214 tests and reported one SQLite disk I/O
error during an existing HTTP test's setup. Inspection found that BaseTestHttp
closed only the calling thread's connection, then deleted files while the queued
database writer remained alive. A permanent lifecycle regression failed before
adding db.stop() and passed afterward. The full suite is rerun with this fix; no
SQLite error was dismissed or hidden.

The actual non-root NVR runtime check passed startup, real CPU inference,
recording, preview, FFmpeg-decoded API playback, UID/private-file permissions,
and graceful shutdown with the changed recording code. The 13 focused recording
tests cover 32 of 37 added executable backend lines (86.5%); this is local measured
coverage, not a new Sonar scan result.

## Final local validation

- 1,215 backend unittest tests pass, including the fixture lifecycle regression.
- Python mypy passes across 392 source files; changed Python files pass Ruff.
- 321 frontend unit tests pass; application/E2E type checks and lint pass.
- Live-page browser run: 24 pass and 11 existing layout-specific skips. Both new
  manual-recording regressions pass with strict unexpected-error collection.
- Production frontend build and the actual non-root runtime check pass.
- Total new permanent cases: 16. Thirteen failed on the original behavior; three
  success-path checks passed before and after.

Validation is local. These tests use the existing CI discovery paths, but a new
remote CI/Sonar result requires publishing the branch. No live NVR was deployed.
