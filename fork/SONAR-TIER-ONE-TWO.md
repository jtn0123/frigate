# Sonar Tier 1 and Tier 2 batch

Baseline: next at 7022dd745, Sonar analysis dated 2026-09-12T20:48:17Z.

| Tier | Definition | Baseline | Addressed in this batch |
| --- | --- | ---: | ---: |
| 1 | All vulnerabilities and bugs | 189 | 62 |
| 2 | Blocker or critical code smells | 404 | 58 |
| 3 | Remaining code smells | 1,077 | 0 |

The 120 baseline IDs are recorded in `sonar-tier-one-two-issues.csv`.
These are source changes awaiting Sonar confirmation, not reported scan closures.

## Changes

- Centralize string sorting in a typed helper that copies its input and preserves
  UTF-16 code-unit order. This keeps cache keys, profile color assignments, labels,
  and filename ordering stable across locales. Thirty-eight sort calls use the
  helper; one no-op sort of rendered React elements is removed.
- Prevent face-library and review-thumbnail rendering from mutating cached arrays.
  Frozen-input regression tests cover the failure mode and reversible sorted copies.
- Return false when external thumbnail deletion raises OSError, matching snapshot
  cleanup and the boolean contract used by event deletion. Inline and missing
  thumbnails remain successful. A regression test reproduced PermissionError
  escaping before the fix; all four thumbnail cases pass afterward.

Most sorting findings were explicit-comparator warnings rather than demonstrated
wrong ordering. Do not describe them as 39 distinct user-visible defects.

## Expanded batch

The original 40 findings are expanded to 120: 62 Tier 1 and 58 Tier 2.
The additional 80 findings comprise:

- 11 predictable ID-generation warnings: use secrets.choice through a shared
  helper, retaining identifier lengths, alphabet, timestamps, and camera prefixes.
  These identifiers are not authentication tokens.
- 12 other Tier 1 findings: explicit documentation-generator sorting, efficient
  recording-existence checks, constructor return cleanup, removal of a redundant
  assignment, three side-effect iterations, and five identical ternaries.
- 30 empty-method findings: 29 explanations of intentional no-op hooks and
  unsupported migration rollback behavior, plus removal of an empty destructor.
  These are maintenance clarifications, not runtime bug fixes.
- Six index-only NumPy queries, six unreachable debug blocks, and two aware UTC
  datetime constructions.
- Four async dialog callback contracts and two RKNN path argument contracts.
- Six error-collector self-tests now verify the injected errors and expected
  collector behavior directly. Event-driven waits replace the fixed delay.
- One detector error path now raises a descriptive ValueError for invalid YOLO
  output metadata, replacing a bare raise outside an exception handler. The new
  regression test reproduces the original RuntimeError for 0, 1, and 4 outputs.

Migration AST comparison confirms all 18 edited migrations retain identical
executable behavior. The ID helper has tests for lengths, alphabet, and secure
character generation; existing replay tests cover the existence-query change.

## Triage notes

- Debug replay uses ModelSelect.exists() because validation needs only presence,
  not a count of all matching recordings.
- Timeline processing already rejects updates without previous event data in its
  queue loop. The reported nullable access is guarded at the caller.
- Admin camera discovery intentionally connects to LAN hosts. Its SSRF finding
  requires review of permitted destinations and redirect behavior, not a blanket
  private-address ban that would disable camera discovery.
- Read-only disk-usage calls on /dev/shm are not unsafe temporary-file creation.
- The motion-preview reduce call already guards against an empty matching list.

No Sonar findings were suppressed, accepted, or marked false positive by this batch.

## Validation

- Backend: 1,095 unittest tests passed in the Linux test container; mypy passed
  for all 368 source files.
- Frontend: 255 unit tests, typecheck, ESLint, the type ratchet, and production
  build passed.
- Browser: the complete desktop/mobile suite passed (428 passed, 93 existing
  skips).
- Ruff formatting/lint and commit hooks passed. The test container was removed.
- These checks do not validate physical cameras, GPUs, or deployment behavior.
