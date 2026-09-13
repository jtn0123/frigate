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

## Complete T1 inventory review, September 13

Refreshed against the scan of next at f6be34759, then integrated next through
2c806288c (PRs 40 and 41). Three new sorting findings expand the tracked T1
inventory from 122 to 125. One original finding closed in the upstream scan.

| T1 disposition | Count |
| --- | ---: |
| Source addressed, awaiting scan confirmation | 72 |
| Reviewed false positives, confirmed closed in Sonar | 35 |
| Hardened, still awaiting security review | 5 |
| Open architectural or dependency risks | 12 |
| Closed by the upstream scan | 1 |

The source count includes the prior 28 T1 fixes. This pass adds 44 source
remediations, three sorting fixes among them, plus five security boundary
hardening items. It does not represent 125 code defects fixed.

### Security changes

- Install npm dependencies from the lockfile with dependency lifecycle scripts
  disabled; explicitly apply the repository's patch-package patches. Pin npm
  and devcontainer CLI versions, and use locally installed test commands.
- Hash-lock OpenVINO converter and Python build dependencies. Reuse the existing
  fork development lock for both CI and the development image. Require wheels
  for these installs and for existing runtime wheel installation commands.
- Keep source-built TensorRT/pysqlite build steps intact. Disable source package
  installation for MemryX dependencies and pybind11 after checking wheel
  availability. Hardware runtime validation remains separate from that check.
- Write go2rtc credentials and the shutdown marker atomically with mode 0600,
  without following an existing final-path symlink. Test replacement failures,
  symlink targets, and file permissions.
- Secure /tmp/cache with mode 0700 before services start and in application
  directory initialization. Existing files remain in place. Symlinks and cache
  directories owned by another user fail closed; an administrator must correct
  those layouts. nginx, go2rtc, and Frigate currently run as root in this image.
- Disallow redirects during administrator-only Reolink detection. Continue to
  support camera HTTP until there is a compatible authenticated TLS path.
- Preserve legacy MD5 model identifiers with an explicit nonsecurity hashing
  flag. Preserve Persian display text using JSON escapes for bidi controls.
- Use numeric bounds for Review minimap timestamps without mutating state.

### Reviewed false positives

Sonar stores a review explanation on each closed issue: 15 nonsecurity random
values (dataset selection, display colors, mock data), one hashing algorithm
name misidentified as a credential, five read-only storage metrics, three exact
integer/sentinel checks, eight local CLI input/output choices, and three fixed
read-only log paths. No rule, quality gate, or scan scope was disabled.

### Remaining risks and required evidence

The 12 open findings are five root-runtime Docker findings, four HTTP camera
compatibility findings, and three dependency findings (the Axera wheel's
transitive dependencies and the ROCm install). These are not waived. A safe
rootless conversion must account for s6, nginx, device permissions, and all
accelerators. Removing HTTP requires a tested option for cameras without TLS.
Dependency locking must preserve the shared runtime's NumPy/accelerator ABI.

The five hardened review items are the cache path and Birdseye pipe, go2rtc
configuration, shutdown marker, and camera request destination. A new scan and
security review must establish their final Sonar disposition.

Validation after integrating current next: 1,134 backend tests, 284 frontend
tests, TypeScript checks, mypy across 385 source files, ESLint, and E2E spec lint
pass. The Linux web image builds successfully with dependency scripts disabled.
PR: https://github.com/jtn0123/frigate/pull/43 (draft while CI and Sonar run).
The web build now permits a configurable 4 GiB Node heap because the Linux
Node 20 build exceeded its default 2 GiB heap while bundling the UI.
