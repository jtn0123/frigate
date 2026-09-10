# Fork ledger

This is a UI/UX-focused fork of [blakeblackshear/frigate](https://github.com/blakeblackshear/frigate).
The backend is kept as close to upstream as possible; every divergence is listed
here with its reason and, where one exists, the upstream pull request that would
make the entry go away.

Rules that keep this fork rebasable (see the "polish" branch):

- `dev` mirrors upstream and is never committed to. All work lives on `polish`,
  rebased onto `upstream/dev` weekly. One report item = one commit.
- Add files rather than editing them. When an upstream file must change, keep
  the hunk small and self-contained.
- Fork-only UI behaviour is gated in `web/src/fork/flags.ts`.
- Never rename, move, or reformat an upstream file.
- No dependency majors upstream has not already taken.
- Upstream first: anything the maintainers would plausibly accept is sent as a
  PR, and the ledger entry is deleted once it merges.

Deployed builds are tagged `fork/<version>-<date>` and published by
`.github/workflows/fork-build.yml` to `ghcr.io/jtn0123/frigate`.

## Divergences

| ID | Area | Files | Why | Upstream PR |
|----|------|-------|-----|-------------|
| S0 | scaffold | `FORK.md`, `fork/`, `web/src/fork/flags.ts`, `.github/workflows/fork-*.yml`, `.pre-commit-config.yaml`, `web/.env.example`, `web/tsconfig.e2e.json`, `Makefile` (new targets only) | Fork infrastructure: ledger, flags, CI that builds an amd64 image from this branch, inner-loop targets | n/a (fork-only) |
