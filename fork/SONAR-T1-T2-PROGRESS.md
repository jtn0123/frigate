# Tier 1 and Tier 2 remediation

Baseline: SonarCloud next, 470 open findings (122 T1, 348 T2).
Issue IDs and source-addressed status are in sonar-t1-t2-progress.csv.
Source-addressed is provisional until a subsequent scan confirms closure.

## Completed in source

- 26 T1 download and repository transport findings, documented separately in
  SONAR-TIER1-DOWNLOADS.md.
- 2 T1 findings: remove the unused YUV crop height parameter (all callers use
  two arguments); move the missing previous-event guard into the timeline
  handler and narrow nullable state before reading it.
- 18 T2 findings: two Whisper sentence/reset issues, four deprecated timezone
  imports, three shadowed loop variables, and nine QR encoder findings.
- Review hover preview regression is a separate runtime fix, not counted as a
  Sonar closure without a matching tracked issue.

## Validation

- 1,104 backend unittest tests pass in the Docker test image as UID 1000.
- Python mypy passes across 372 source files.
- 272 frontend unit tests pass; TypeScript app compilation passes.
- Whisper regressions failed on the baseline: one-word sentences lost output,
  and the VAC processor rejected reset offsets.
- Timezone tests cover fractional offsets, DST periods, invalid timezone
  fallbacks, and legacy case-insensitive input such as utc. The full backend
  suite caught the lowercase timezone compatibility issue before completion.
- Seven QR compatibility cases retain exact encoded modules, masks, and type
  metadata from the baseline, including Unicode and QR versions 7, 32, and 40.

## Remaining work

94 T1 and 327 T2 baseline findings remain unaddressed in source. Among these
are security-sensitive operations requiring individual review and 318 complex
functions requiring refactoring. Do not disable rules or weaken the quality
gate to report zero. No server-side findings were dismissed by this batch.


## Next pass

Three additional T2 findings are addressed in source (49 total, 28 T1 and 21 T2):

- Remove obsolete clip-retention file deletion using a .None extension. Event
  clip expiry now updates metadata only; recording retention owns video files.
- Simplify Review label/zone query construction while retaining any-match
  behavior, verified with both object and audio labels across multiple zones.
- Reduce nested resize-observer callbacks and verify dimension delivery and
  observer disconnection on unmount.

The clip-retention regression fails against the baseline because unlink is
called. Validation: 1,106 backend unittest tests and 273 frontend unit tests pass.
Python mypy, TypeScript compilation, lint checks, and generated API spec
consistency checks pass.
