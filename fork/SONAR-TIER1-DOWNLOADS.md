# Tier 1 build-download hardening

Baseline: next at 0b139bdc6, post-PR39 scan, 122 Tier 1 findings.

This batch addresses 26 unique Tier 1 findings in source:

| Area | Findings |
| --- | ---: |
| Main Dockerfile | 10 |
| TensorRT ARM64 Dockerfile | 1 |
| Jetson FFmpeg build script | 5 |
| ROCm downloads and package repository | 3 |
| Synaptics downloads | 2 |
| MemryX repository key | 1 |
| Main and Raspberry Pi package repositories | 3 |
| Documentation demo link | 1 |

The tracked IDs are in sonar-tier1-downloads-issues.csv. Closure counts require
another Sonar scan; 26 addressed findings do not establish 26 server closures.

All 21 artifact downloads now enforce HTTPS for the initial URL and every
redirect, verify certificates, and fail on HTTP errors. Curl and CA certificates
are installed in each affected build stage. Output names are preserved.
The TensorFlow model uses the same object under the HTTPS Google Storage bucket
because the old download.tensorflow.org hostname has an invalid TLS certificate.
The audio archive downloads completely before extraction, so download errors
cannot be hidden by a successful downstream pipeline command.

## Validation

- The previous unrestricted curl behavior followed a local HTTPS redirect to
  HTTP and accepted its artifact, demonstrating the transport weakness.
- Regression tests exercise options read from 61 source download commands:
  direct HTTPS, HTTPS redirects, rejected HTTP downgrades, rejected initial
  HTTP, and HTTP error responses. All passed.
- The actual Docker download-tools stage built successfully. The replacement
  TensorFlow archive was downloaded and its expected model files verified.
- All 14 fork script tests passed, along with Ruff, shell syntax and diff checks.
- All 13 distinct artifact endpoints responded successfully over HTTPS. Kaggle
  rejects HEAD requests, so its GET response was downloaded and verified as a
  tar archive containing 1.tflite.

This validates download transport and endpoints, not complete NVIDIA/Jetson
compilation or camera/GPU runtime behavior. Dependency pinning and archive
contents are separate concerns and were not counted as resolved by this batch.

## Additional transport validation

The follow-up adds 10 tracked findings to the first 16. ROCm, Synaptics and
MemryX downloads reject protocol downgrades. Explicit Debian package sources
and the public documentation demo link use HTTPS. The related ROCm backports
source was updated for consistency without counting it as an extra finding.

All six follow-up endpoint checks passed over HTTPS. A real Docker-based APT
update downloaded and verified repository metadata for bookworm (including
non-free components), bookworm-backports, and trixie using only HTTPS sources.
No driver installer, full ROCm build, or live deployment was run.

## Reviewed without speculative changes

The timeline map callback accepts only one argument, so the array index cannot
change its result. Several floating-point findings compare deliberate zero or
integer class sentinels. The ffprobe tool uses an argument list without a shell;
its executable override is an intentional local CLI capability. Those findings
were not suppressed or counted as fixed.
