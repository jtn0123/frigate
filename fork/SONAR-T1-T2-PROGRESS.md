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

94 T1 and 330 T2 baseline findings remain unaddressed in source. Among these
are security-sensitive operations requiring individual review and 319 complex
functions requiring refactoring. Do not disable rules or weaken the quality
gate to report zero. No server-side findings were dismissed by this batch.
