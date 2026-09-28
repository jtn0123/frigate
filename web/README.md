This is the Frigate frontend which connects to and provides a User Interface to the Python backend.

# Web Development

## Installing Web Dependencies Via NPM

Within `/web`, run:

```bash
npm install
```

## Running development frontend

Within `/web`, run:

```bash
PROXY_HOST=<ip_address:port> npm run dev
```

The Proxy Host can point to your existing Frigate instance. Otherwise defaults to `localhost:5000` if running Frigate on the same machine.

## Extensions
Install these IDE extensions for an improved development experience:
- eslint

## Fork workflow

This fork adds checks and generated files on top of the upstream setup:

- **Checks.** `npm run lint` (ESLint plus the e2e spec and fixture lint),
  `npm run typecheck` (the app, the e2e specs, the generated API types and the
  stricter fork typecheck) and `npx vitest run`. `make check-fast` from the
  repository root runs these for changed files only.
- **API types.** `src/types/fork/api.gen.ts` is generated from
  `docs/static/frigate-api.yaml`. After the backend's endpoints change,
  regenerate the spec (`python3 generate_api_auth_spec.py` from the root),
  then run `node scripts/fork/gen-api-types.mjs`. Never edit either file by
  hand; `npm run typecheck` fails when they drift.
- **Translations.** Put user-facing strings in `public/locales/en/` and use
  `t()`. Fork strings go in the `fork` namespace (`fork.json`), which ships
  in English only and is loaded from `en` in every language. After adding
  `t()` calls run `npm run i18n:extract`; `npm run i18n:extract:ci` checks
  that the locale files match the source. The `config/*.json` files are
  generated from the Pydantic models by `generate_config_translations.py`.
- **Browser tests.** See [`e2e/README.md`](e2e/README.md).
- **Dependency patches.** See [`patches/README.md`](patches/README.md).
