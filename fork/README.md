# fork/

Tooling that exists only in this fork. Nothing here is shipped in the image.

- `Dockerfile.test` layers the working tree's Python sources over the matching
  upstream image so backend unit tests, mypy, and the API-spec check run against
  the real runtime without a 40-minute image build. Dev tools are installed
  before the sources are copied, so a Python edit rebuilds it in about a second.
  Used by `make test-py` and `.github/workflows/fork-checks.yml`.
- `scripts/check.sh` runs every CI gate locally (`make check`), or only what
  changed since `origin/main` (`make check-fast`). Host gates run one after
  another, the Docker gates beside them; see the script header for why.
- `scripts/py-checks.sh` runs mypy, the API spec check and unittest in the test
  image at the same time (`make check-py`, CI "Python - mypy, API spec, unittest").
- `scripts/ci-changes.sh` tells "Fork - Checks" whether web or Python files
  changed, so docs-only commits skip both suites.
- `scripts/wt.sh` creates a section worktree with node_modules and its own e2e
  port (`make wt NAME=<name>`).
- `demo/` overlays this checkout on the rc2 image with three looping sample
  cameras (`make demo-up` / `demo-down` / `demo-logs`). Ports are loopback-only.
  See `fork/demo/README.md`.

Inner loop (from the repo root):

```
make wt NAME=<name>                        # new worktree: branch, deps, e2e port
make check-fast                            # changed-only gates, for every commit
make check                                 # every CI gate, before a PR
make dev-web PROXY_HOST=<frigate-host>:5000   # vite against a live Frigate
make lint                                  # ruff + eslint + e2e spec lint
make typecheck                             # tsc for the app and e2e specs (incremental)
make test-web                              # vitest
make e2e                                   # playwright, fully mocked (port from web/.e2e-port)
make test-py TESTS=frigate.test.test_x     # backend unittest in the thin image
make check-py                              # mypy + API spec drift + unittest, in parallel
make demo-up                               # local overlay Frigate on 127.0.0.1:8971
make demo-down
make demo-logs
```

Caches live in `web/.cache/` (eslint, tsc) and are safe to delete. Each
worktree builds its own test image (`frigate-fork-test-<dir>`), so parallel
worktrees never test each other's sources.

Gotcha: `vite build --outDir` must stay inside `web/`. The monaco plugin joins
an absolute outDir onto `web/`, so `--outDir /tmp/x` writes worker bundles to
`web/tmp/x` and eslint then lints them.
