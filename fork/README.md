# fork/

Tooling that exists only in this fork. Nothing here is shipped in the image.

- `Dockerfile.test` layers the working tree's Python sources over the matching
  upstream image so backend unit tests, mypy, and the API-spec check run against
  the real runtime without a 40-minute image build. Used by `make test-py` and
  `.github/workflows/fork-checks.yml`.

Inner loop (from the repo root):

```
make dev-web PROXY_HOST=<frigate-host>:5000   # vite against a live Frigate
make lint                                  # ruff + eslint + e2e spec lint
make test-web                              # vitest
make e2e                                   # playwright, fully mocked
make test-py                               # backend unittest in the thin image
make check-py                              # mypy + API spec drift
```
