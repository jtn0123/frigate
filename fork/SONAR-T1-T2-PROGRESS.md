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
| Source addressed, awaiting scan confirmation | 76 |
| Reviewed false positives, confirmed closed in Sonar | 35 |
| Hardened, still awaiting security review | 4 |
| Open architectural risks | 9 |
| Closed by the upstream scan | 1 |

The source count includes the prior 28 T1 fixes, 47 source remediations
from the inventory pass, and the camera destination redesign below. Four
additional security boundary hardening items remain under review. It does not represent 125 code defects fixed.

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

### Reuse prior reviews before investigating

Start each Sonar triage pass by matching issue keys against
`fork/sonar-t1-t2-progress.csv`. Skip investigation of entries marked
`reviewed-false-positive-confirmed` when the relevant code and security
boundary are unchanged. Use the category rationale above and the existing
Sonar issue review comment instead of repeating the investigation.

For a new issue key on an equivalent finding, compare the rule, file, relevant
code, and prior review evidence first. Do not automatically close a new finding.
Reopen investigation when code, data exposure, privileges, analyzer evidence,
or the assumptions supporting the previous review change. Fetch unresolved
issues for routine work and keep false-positive dispositions separate from
source fixes in counts. This avoids repeat agent analysis; it does not disable
Sonar scanning of the code.

The two PR-only private-file issue keys below are also reviewed false positives;
they are separate from the baseline CSV inventory.

### Remaining risks and required evidence

The nine open findings are five root-runtime Docker findings and four HTTP
camera compatibility findings. These are not waived. A safe
rootless conversion must account for s6, nginx, device permissions, and all
accelerators. Removing HTTP requires a tested option for cameras without TLS.
Axera and ROCm addon dependencies are now hash-locked against the validated
shared runtime versions, preserving NumPy 1.26.4 and protobuf 5.29.6. Target
platform wheel downloads and hashes pass; this does not constitute a hardware
inference test.

The five hardened review items are the cache path and Birdseye pipe, go2rtc
configuration, shutdown marker, and camera request destination. A new scan and
security review must establish their final Sonar disposition.

Validation after integrating current next: 1,137 backend tests, 284 frontend
tests, TypeScript checks, mypy across 385 source files, ESLint, and E2E spec lint
pass. The Linux web image builds successfully with dependency scripts disabled.
PR: https://github.com/jtn0123/frigate/pull/43 (draft while CI and Sonar run).
The web build now permits a configurable 4 GiB Node heap because the Linux
Node 20 build exceeded its default 2 GiB heap while bundling the UI.

CodeQL follow-up: the old camera host validator ignored everything after the
first colon. Ten malformed host/port variants reproduced the gap. The validator
now checks the entire authority and limits ports to 1 through 65535. Tests also
prove viewer and missing-role requests cannot invoke camera discovery.

### PR scan and gate outcome

The c67bd8726 scan reported 89.1% new-code coverage, zero new duplication,
zero bugs, and four security findings. The two runtime-file findings
(AaCaK1PY136A9JFWt-nx and AaCaK1Up136A9JFWt-n9) were reviewed against the
private atomic writer and filesystem tests, and closed as false positives
on the PR. These PR reviews are separate from the 35 baseline closures.

The PR gate still requires disposition of administrator-selected camera
requests (AaCaK1LW136A9JFWt-nv) and the existing root-run final image
(AaCaK1TP136A9JFWt-n8). The latter is a newly reported PR finding on an
unchanged final FROM stage, additional to the five root-image findings in
the baseline inventory. CodeQL records the camera request alert as mitigated
by the verified controls. The user chose to keep these Sonar findings open
for a validated redesign.
Root-runtime, administrator-selected destinations, and HTTP camera findings
must not be accepted as compatibility exceptions. No accepted
risk has been counted as a code fix or silently removed from the gate.

Follow-up cleanup removes the now-unused timeline insertion argument and clip
retention assignment. Twelve malformed host variants, including non-ASCII
ports, are rejected. The final focused timeline, retention, and camera tests
pass after these changes; the combined suite previously passed 1,137 tests.

### Latest verified scan and redesign exit criteria

The b2d8b36c6 scan passes new-code coverage (88.1%, minimum 80%),
new duplication (0.0%), reliability, and maintainability. All non-Sonar CI
checks passed, including the three E2E shards. The quality gate fails on
security rating. Documentation does not resolve that failure or authorize a
merge. PR #43 remains a draft.

| Open area | Required redesign and validation before closure |
| --- | --- |
| Root-run containers | Coordinate s6, nginx, Frigate, go2rtc, writable directories, and device access under a non-root runtime. Prove startup, recording, playback, upgrades, and supported accelerator access without silently restoring root. |
| Administrator-selected camera destinations | Introduce explicit destination authorization with DNS and connection-time enforcement. Test unauthorized destinations, redirects, DNS changes, and approved LAN cameras. Existing host validation and disabled redirects are mitigations, not complete closure. |
| HTTP camera support | Add authenticated TLS with certificate validation and a tested migration path for supported cameras. Document cameras requiring HTTP and keep their findings open until the behavior is safely redesigned. |

Keep these findings open in Sonar. Do not accept compatibility exceptions,
add blanket exclusions, or count documentation as a source fix. Close a finding
only after implementation, relevant regression and compatibility evidence, and
review of the resulting scan support closure.

### Implemented security redesign follow-up

The camera destination finding now has server-configured exact targets, pinned
IP connections, verified HTTPS, and no redirect or environment-proxy routing.
The baseline camera key moves from hardened-awaiting-review to source-addressed:
76 baseline T1 source-addressed, four hardened-awaiting-review, 35 reviewed false
positives, nine open architectural findings, and one upstream closure. Counts
still require a next-branch scan for confirmation.

The PR-only main-image root finding is addressed by a non-root final runtime,
build-time directory preparation, unprivileged logging, and removal of s6
privilege-elevation bits. It is additional to the baseline inventory. Five
accelerator-specific root findings and HTTP camera findings remain open.

See [security redesign and migration](SONAR-SECURITY-REDESIGN.md) before deploying.
The main-image default user and optional camera-probing configuration change;
existing installations require mount permissions and discovery target setup.
This supersedes the earlier statement that both PR blockers still await source
implementation. Scan and deployment/hardware validation remain distinct gates.

Local validation of the implemented redesign: 1,151 backend tests pass, including
23 focused camera/security tests. Mypy passes across 388 files. API schema check,
Ruff, shell syntax checks, and the synthetic non-root runtime check pass.
The latter verifies real CPU inference, recording, API clip decoding, preview, all process UIDs,
private permissions, and clean service shutdown. CI and a fresh Sonar scan are
pending on the follow-up commit.

The c0e140c4b PR scan confirms zero vulnerabilities, zero bugs, 90.5% new-code
coverage, zero new duplication, and a passing quality gate. All CI checks,
including the non-root runtime check and three E2E shards, pass on that commit.
The scan also reported new camera-endpoint complexity from the added guards;
response-shape parsing is now extracted into a focused helper. The 1,151-test
suite and 23 focused tests pass after that cleanup. Final scan confirmation of
the complexity cleanup is pending; the two PR security blockers are confirmed
closed by the c0e140c4b scan, not waived.

Integration with next at b9fbec894 (PRs 46 and 47) preserves the new secrets
handling and go2rtc execution restrictions alongside the private atomic writer.
The preview-player automatic merge duplicated its fallback-image attribute;
the duplicate is removed. The runtime check now builds the production nginx
stage to support the new nginx-vod-module configuration. The previous dependency
image rejects `vod_hls_version`, so it cannot validate that runtime configuration.

Combined local validation: 1,201 backend tests, 310 frontend tests, mypy across
390 files, generated API/type checks, frontend lint and production build pass.
The integrated runtime passes CPU inference, recording, preview, decoded API
playback, private permissions, and graceful service shutdown with the rebuilt
nginx. Final PR CI and Sonar confirmation follow the integration commit.
