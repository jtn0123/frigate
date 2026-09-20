# Dependency refresh, September 2026

Base: `77f81d67e13fee024f737e1fbb6d840c9a1336a8` on `origin/next`.
Ledger: F4 (Vitest portion plus compatible refresh), F7 (setuptools).

## Changes

- Four RJSF packages: 6.10.0 to 6.10.1.
- Konva 10.5.0 to 10.6.0; React Konva 19.2.7 to 19.3.0.
- React Hook Form 7.87.0 to 7.88.0; React Router DOM 7.18.3 to 7.18.4.
- Testing Library DOM 10.4.1 to 10.4.2; Autoprefixer 10.5.6 to 10.6.1.
- Prettier 3.9.6 to 3.9.8; Rollup 4.60.0 to 4.63.4 (still exact-pinned).
- Vitest and coverage-v8 3.2.7 to 4.1.11, pinned to the 4.1 patch series.
  This fixes GHSA-82fw-gwwq-j7x9 without requiring Vite 8 or Vitest 5.
- Setuptools 77.0.3 to 84.0.0 in the requirement, hash lock, and all five
  bootstrap pins across main, ROCm and TensorRT. The regression test checks
  that the lock and bootstrap pins match the security-patched requirement.

Keep the existing Radix/Monaco patches and dependency overrides. TypeScript 7,
NumPy 2, Tailwind 4 and the other coordinated major migrations remain separate.
PR #49 is superseded by the Router 7 work already on next. PR #50's manifest-only
change does not update the lock or bootstrap paths; F7 covers those paths.
Neither existing PR was modified by this local change.

## Initial local validation

Validation used the same base archive and changed files on the internal drive
because external-drive reads stalled the initial make check-fast run.

- npm audit: three moderate findings before; zero findings afterward.
- All three patch-package patches apply successfully.
- ESLint, browser spec/fixture lint, application and E2E TypeScript, generated
  API type check, strict fork typing, i18n extraction, and type ratchet passed.
  The archive's ratchet checked its unchanged baseline; Git base comparison
  was skipped because the validation archive has no Git metadata.
- 624 unit tests passed with coverage on Node 22.23.2, matching CI's major,
  and Node 26.8.1. Four workers avoided a timeout in the initial unrestricted
  run; the same test passed independently without changing its timeout.
- 146 fork tooling tests passed; the ledger check passed.
- Production bundle: 396401 / 412650 gzip bytes. Budget unchanged.
- Browser suite: 679 passed, 95 skipped across desktop/mobile, no failures.
- Setuptools pin guard failed on a manifest/lock mismatch, then passed after
  the lock and bootstrap pins were updated.
- A fresh Python 3.11.14 environment installed the hash-locked build tools,
  compiled pysqlite3 0.5.3 with SQLite amalgamation 3.46.1, built and installed
  its macOS ARM64 wheel, and successfully executed SELECT 1. Setuptools 84
  and scikit-build 0.18.1 imported successfully.
- The existing Linux test image already has setuptools 84; its onvif and
  py3nvml imports passed. This is supplemental evidence, not an image rebuild.

## Linux build follow-up and release validation

On September 20, the Linux ARM64 smoke build passed with Python 3.11 and the
hash-locked setuptools 84.0.0/scikit-build 0.18.1 tools. It ran the repository's
`docker/main/build_pysqlite3.sh`, installed the resulting Linux wheel, imported
it, and successfully executed SELECT 1. This replaces the earlier blocked
attempts, which stalled on local image reads and a Docker Hub TLS timeout.

The full gate and CI/Sonar results are recorded in
[PR #87](https://github.com/jtn0123/frigate/pull/87). The smoke build exercises
the native SQLite build, not every production image variant. No server or GPU
runtime was changed, and physical GPU validation is outside this update.
