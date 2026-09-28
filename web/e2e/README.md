# Browser tests

The Playwright suite runs the production build against a fully mocked
backend. No Frigate server, camera or database is involved: every API route
and the WebSocket are answered by `helpers/api-mocker.ts` and
`helpers/ws-mocker.ts` from the fixtures in `fixtures/mock-data/`.

## Running

From `web/`:

```bash
npm run e2e:build          # build once; rerun after changing app code
npm run e2e                # every spec, desktop, mobile and tablet projects
npx playwright test --config e2e/playwright.config.ts e2e/specs/live.spec.ts
npx playwright test --config e2e/playwright.config.ts --grep "severity tab"
npx playwright test --config e2e/playwright.config.ts --project=desktop
npm run e2e:ui             # interactive runner for debugging
```

From the repository root, `make e2e` does the build and the run.

**Port.** The suite serves the build with `vite preview` on `E2E_PORT`
(default 4173). `make wt` gives each worktree its own port in
`web/.e2e-port`, which `make e2e` and `make check` read, so worktrees can run
the suite side by side. Outside `make`, pass it yourself:
`E2E_PORT=$(cat .e2e-port) npm run e2e`.

## Layout

| Path                          | What it holds                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `specs/`                      | Upstream specs.                                                               |
| `specs/fork/`                 | The fork's specs. Add new specs here.                                         |
| `specs/_meta/`                | Tests of the harness itself (app readiness, error collector, mock overrides). |
| `fixtures/frigate-test.ts`    | The `test` and `expect` every spec imports, with the `frigateApp` fixture.    |
| `fixtures/mock-data/`         | JSON fixtures and TypeScript factories for API responses.                     |
| `fixtures/error-allowlist.ts` | Console and request errors every test tolerates, each with its reason.        |
| `helpers/`, `pages/`          | Mockers, readiness helpers and page objects.                                  |
| `scripts/`                    | The spec lint and the fixture validator.                                      |

## Writing a spec

- Import `test` and `expect` from `fixtures/frigate-test.ts`, not from
  `@playwright/test`. The fixture registers the mocks before navigation and
  fails the test on any console error, page error or failed same-origin
  request that is not expected.
- Declare the errors a test provokes on purpose with the `expectedErrors`
  fixture option. Add to `fixtures/error-allowlist.ts` only for noise every
  test sees, with a comment explaining it.
- Override a response for one test by passing overrides to
  `frigateApp.installDefaults(...)` rather than editing a shared fixture.
- Tag viewports in the title: every spec needs at least one `@mobile` test.
  `@mobile-only` and `@desktop-only` keep a test to one project, and
  `@tablet` or `@tablet-only` add it to the tablet project. Choose the scope
  with tags instead of skipping at run time.
- `npm run e2e:lint` (part of `npm run lint`) rejects `waitForTimeout`,
  assertions behind `if (await ...isVisible())` and similar lenient patterns.
  A line can opt out with `// e2e-lint-allow` and a comment saying why.

## Mock data

JSON fixtures are validated against the OpenAPI spec
(`docs/static/frigate-api.yaml`) by `scripts/validate-fixtures.mjs`, so a new
fixture must match its endpoint's response schema. After a backend model
changes, regenerate the generated fixtures from the repository root:

```bash
PYTHONPATH=. python3 web/e2e/fixtures/mock-data/generate-mock-data.py
```

It needs the backend's Python dependencies, so it is easiest to run in the
fork's test image (`make fork-test-image`).
