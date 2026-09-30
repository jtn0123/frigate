# Security finding triage

The standing record of what the fork decided about each open scanner
finding, so an accepted risk can be told apart from one nobody looked at.
Reporting instructions are in [`SECURITY.md`](../SECURITY.md).

**Reviewed:** 2026-09-28, on `next` at `49540f110`.
**Next review:** by 2026-12-28, or when a scanner reports a new finding.

## Keeping it current

- Add a row when a scanner reports a finding that is not fixed in the same
  change. Remove the row, or mark it fixed with the commit, once the scanner
  confirms the finding closed.
- **Accepted** means the finding is understood and not worth changing, with
  the reason. **Mitigated** means the risk is reduced but the fix (usually an
  upgrade) is still wanted. **Open** means no decision yet.
- Revisit every row at the review date above. An accepted risk whose
  reasoning no longer holds becomes Open again.

## Current status

| Source | Open findings |
|---|---|
| GitHub code scanning (CodeQL) | 0 |
| SonarCloud vulnerabilities, `next` | 10, below |
| SonarCloud security hotspots to review, `next` | 0 |
| Dependabot alerts | 99: 92 in `docs/`, 7 in `fork/audio_trial/` |

Earlier Sonar batches and their fixes are described in
`fork/SONAR-BLOCKERS-SECURITY.md`, `fork/SONAR-SECURITY-RELIABILITY.md`,
`fork/SONAR-DOWNLOAD-SECURITY.md` and `fork/SONAR-SECURITY-REDESIGN.md`.

## SonarCloud

Links open the issue on the `next` branch.

| Finding | Where | Status | Reason |
|---|---|---|---|
| [python:S5443](https://sonarcloud.io/project/issues?id=jtn0123_frigate&branch=next&open=AaCOHy4u9tFduPng09-m), [python:S5443](https://sonarcloud.io/project/issues?id=jtn0123_frigate&branch=next&open=AaCOHy4u9tFduPng09-n) publicly writable directory | `frigate/const.py:15-16` (`/tmp/cache`) | Mitigated | Upstream path constant. `/tmp/cache` is inside the container, not the host's `/tmp`, and the image's prepare step refuses to start unless it is a real directory (not a symlink) owned by the user Frigate runs as, then sets it to mode 0700 (`ensure_private_directory`, fork I19). The same check applies to the images that run as root. Moving the path would diverge every place that writes recording segments. |
| python:S5443 publicly writable directory (marked `NOSONAR`) | `frigate/fork/log_summary.py` `LOG_PATHS` (`/dev/shm/logs/*/current`) | False positive | The s6 log files upstream's `/logs` endpoint also reads (`frigate/api/app.py`). The log summary (I58) only opens them for reading and never creates anything there. |
| [typescript:S5332](https://sonarcloud.io/project/issues?id=jtn0123_frigate&branch=next&open=AaCOHzhd9tFduPng0-ML), [typescript:S5332](https://sonarcloud.io/project/issues?id=jtn0123_frigate&branch=next&open=AaCOHzhd9tFduPng0-MM) clear-text `http` URL | `web/src/types/cameraWizard.ts:33,37` | Accepted | Upstream code. The camera wizard's Reolink FLV template and example URL; those cameras serve FLV only over HTTP on the local network. |
| [docker:S6471](https://sonarcloud.io/project/issues?id=jtn0123_frigate&branch=next&open=AaCOHz9Y9tFduPng0-WZ) and four more image runs as root | `docker/rpi`, `docker/rockchip`, `docker/synaptics`, `docker/tensorrt` (amd64 and arm64) Dockerfiles | Accepted | Upstream accelerator images the fork does not build or ship. They need device access that the upstream image design grants through root. See `fork/SONAR-SECURITY-REDESIGN.md`. The other three: [rockchip](https://sonarcloud.io/project/issues?id=jtn0123_frigate&branch=next&open=AaCOH0L89tFduPng0-Y9), [synaptics](https://sonarcloud.io/project/issues?id=jtn0123_frigate&branch=next&open=AaCOH0N99tFduPng0-ZD), [tensorrt amd64](https://sonarcloud.io/project/issues?id=jtn0123_frigate&branch=next&open=AaCOH0Ge9tFduPng0-YT), [tensorrt arm64](https://sonarcloud.io/project/issues?id=jtn0123_frigate&branch=next&open=AaCOH0DV9tFduPng0-YD). |
| [shell:S8541](https://sonarcloud.io/project/issues?id=jtn0123_frigate&branch=next&open=AaCtJHQFOC7F2a_-QVze) `pip install` without `--only-binary` | `.devcontainer/features/onnxruntime-gpu/install.sh:10` | Accepted | Upstream devcontainer feature, run only when a developer builds the devcontainer, and installing from PyPI's `onnxruntime-gpu` wheels. Not part of any shipped image. |

## Dependabot

| Finding | Where | Status | Reason |
|---|---|---|---|
| 92 alerts (2 critical: `shell-quote`, `websocket-driver`), for example [#74](https://github.com/jtn0123/frigate/security/dependabot/74) and [#92](https://github.com/jtn0123/frigate/security/dependabot/92) | `docs/package-lock.json` | Accepted, bumps welcome | The Docusaurus documentation site's build and dev-server tooling. It is not installed in the Frigate image, and the fork does not host the docs, so no deployed service parses untrusted input with these packages. Merge Dependabot's `docs/` bumps when they pass CI rather than tracking each alert. |
| `transformers` 4.57.6: [#234](https://github.com/jtn0123/frigate/security/dependabot/234), [#237](https://github.com/jtn0123/frigate/security/dependabot/237), [#238](https://github.com/jtn0123/frigate/security/dependabot/238), [#240](https://github.com/jtn0123/frigate/security/dependabot/240) | `fork/audio_trial/requirements.in` | Mitigated, upgrade wanted | Only the optional audio trial companion installs it. `infer.py` loads CLAP with `local_files_only=True` from the snapshot pinned by SHA-256 in `models.lock.json`, so no remote or unverified model reaches the code-execution paths. It never calls `save_pretrained`. Upgrade to 5.10 or later once the trial's benchmark confirms CLAP results are unchanged. |
| `torch` 2.8.0: [#235](https://github.com/jtn0123/frigate/security/dependabot/235), [#236](https://github.com/jtn0123/frigate/security/dependabot/236), [#239](https://github.com/jtn0123/frigate/security/dependabot/239) | `fork/audio_trial/requirements.in` | Mitigated, upgrade wanted | Memory corruption in `unpack_sequence`, `lstm_cell` and `torch.jit.script`, which the trial does not call with untrusted input: it runs a pinned local model on audio from Frigate's own recordings. Upgrade together with `transformers`. |
