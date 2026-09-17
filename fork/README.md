# fork/

Tooling that exists only in this fork. Nothing here is shipped in the image.

- `Dockerfile.test` layers the working tree's Python sources over the matching
  upstream image so backend unit tests, mypy, and the API-spec check run against
  the real runtime without a 40-minute image build. Dev tools are installed
  before the sources are copied, so a Python edit rebuilds it in about a second.
  Used by `make test-py` and `.github/workflows/fork-checks.yml`.
- `scripts/check.sh` runs every CI gate locally (`make check`), or only what
  changed since `origin/next` (`make check-fast`). Host gates run one after
  another, the Docker gates beside them; see the script header for why.
- `scripts/release_notes.py` writes a release's notes from the fork's own
  commits (tests: `scripts/test_release_notes.py`). "Fork - Build image" runs it
  for every `main` build and publishes the GitHub Release.
- `scripts/promote.sh` moves `main` to `next` (`make promote`) once
  "Fork - Checks" is green on `next`, after previewing the release notes.
- `scripts/py-checks.sh` runs mypy, the API spec check and unittest in the test
  image at the same time (`make check-py`, CI "Python - mypy, API spec, unittest").
  unittest includes the `audio_trial` and `monitoring` suites, as in CI.
- `scripts/ci-changes.sh` tells "Fork - Checks" whether web or Python files
  changed, so docs-only pull requests skip both suites. A push to `next`
  always runs the web jobs: Sonar's branch gate needs their browser coverage
  (see `SONAR-CI.md`).
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
make promote                               # release: main := next, image + GitHub Release
make demo-up                               # local overlay Frigate on 127.0.0.1:8971
make demo-down
make demo-logs
```

## Owner setup

Things only the repository owner can do, because they need GitHub or
SonarCloud admin rights. Agents never create, read or print these tokens.

### `FORK_SYNC_TOKEN` (upstream sync)

"Fork - Upstream sync" pushes upstream's commits to `dev` and `sync/upstream`.
Those commits change `.github/workflows`, which GitHub refuses from the default
`GITHUB_TOKEN`, so the workflow stops in its first step until this secret
exists (I18, I27).

1. GitHub > Settings > Developer settings > Personal access tokens >
   Fine-grained tokens > Generate new token.
2. Resource owner `jtn0123`; Repository access: Only select repositories,
   `jtn0123/frigate`.
3. Repository permissions: Contents: Read and write, and Workflows: Read and
   write. Leave everything else at No access (Metadata: Read-only is added
   automatically).
4. Pick an expiry, note the date, generate and copy the token.
5. In `jtn0123/frigate`: Settings > Secrets and variables > Actions > New
   repository secret. Name `FORK_SYNC_TOKEN`, value the token. Or, from a
   terminal, `gh secret set FORK_SYNC_TOKEN -R jtn0123/frigate` and paste it at
   the prompt.
6. Actions > "Fork - Upstream sync" > Run workflow. When it is green, close the
   open "Upstream sync failed" issue.

When the token expires the pushes are rejected again and the same issue comes
back: repeat the steps with a new token.

Caches live in `web/.cache/` (eslint, tsc) and are safe to delete. Each
worktree builds its own test image (`frigate-fork-test-<dir>`), so parallel
worktrees never test each other's sources.

Gotcha: `vite build --outDir` must stay inside `web/`. The monaco plugin joins
an absolute outDir onto `web/`, so `--outDir /tmp/x` writes worker bundles to
`web/tmp/x` and eslint then lints them.
