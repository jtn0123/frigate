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
| G3 | backend | `frigate/api/{auth,camera,debug_replay,event,export,media,record,review}.py`, `pyproject.toml` | Route handlers no longer run peewee queries on the event loop: sync-only handlers are plain `def`, handlers that await auth wrap DB calls in `asyncio.to_thread`; full ruff `ASYNC` family enabled | candidate |
| G4 | backend | `frigate/api/event.py`, `frigate/test/http_api/test_http_event.py` | `/events/search` pushes ORDER BY and LIMIT into SQL for non-relevance sorts, bounds the candidate set to the vector-search hits, and replaces the non-sargable JSON LEFT JOIN with a windowed review-segment lookup | candidate |
| E1 | nginx | `docker/main/rootfs/usr/local/nginx/conf/security_headers.conf` (new), `nginx.conf`, `auth_request.conf`, `templates/listen.gotmpl` | Browser security headers (nosniff, SAMEORIGIN, Referrer-Policy, Permissions-Policy, report-only CSP) and HSTS re-added in every location that calls `add_header`, since nginx does not inherit them | candidate |
| E2 | backend | `frigate/api/{auth,classification,media,fastapi_app}.py`, `frigate/test/http_api/test_http_auth_gates.py`, `fork/Dockerfile.test`, `.dockerignore` | Every route declares exactly one auth gate, verified by a startup assertion and a test; bare `/review` exemption prefix replaced by exact paths; swallowed exemption exception is logged | candidate |
| E3 | backend | `frigate/api/media.py`, `frigate/test/http_api/test_http_media.py` | `preview_thumbnail` resolves the user-supplied file name with `safe_join` under `CACHE_DIR/preview_frames` instead of bare `sanitize_filename` | candidate |
| B1 | backend | `frigate/api/fastapi_app.py`, `frigate/test/http_api/test_http_password.py` | `HTTPException` handler renders `{success, message, detail}` so both API error conventions work for every client | candidate |
