#!/usr/bin/env node
/**
 * Generate TypeScript types from the API spec the backend generates.
 *
 * The one untyped seam in an otherwise strict app was the client/server
 * contract: web/src/types was hand written, so a changed response compiled
 * fine and broke at runtime (A5). docs/static/frigate-api.yaml is produced by
 * generate_api_auth_spec.py and CI-checked, so it is the source of truth here.
 *
 *   node scripts/fork/api-types.mjs           # regenerate
 *   node scripts/fork/api-types.mjs --check   # fail if the file is stale
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const repoRoot = resolve(webRoot, "..");
const spec = join(repoRoot, "docs/static/frigate-api.yaml");
const output = join(webRoot, "src/types/fork/api.gen.ts");
const check = process.argv.includes("--check");

const result = spawnSync(
  process.execPath,
  [join(webRoot, "node_modules/openapi-typescript/bin/cli.js"), spec],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  console.error("openapi-typescript failed");
  process.exit(1);
}

const generated = result.stdout;
const current = readFileSync(output, "utf8");
if (generated === current) {
  console.log("src/types/fork/api.gen.ts is up to date");
  process.exit(0);
}
if (check) {
  console.error(
    "src/types/fork/api.gen.ts is out of date with docs/static/frigate-api.yaml.\n" +
      "Regenerate both:\n" +
      "  python3 generate_api_auth_spec.py\n" +
      "  npm run --prefix web api:types",
  );
  process.exit(1);
}
writeFileSync(output, generated);
console.log("Wrote src/types/fork/api.gen.ts");
