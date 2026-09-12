#!/usr/bin/env node
/**
 * Generate web/src/types/fork/api.gen.ts from docs/static/frigate-api.yaml.
 *
 *   node scripts/fork/gen-api-types.mjs           # write
 *   node scripts/fork/gen-api-types.mjs --check   # fail if stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const repoRoot = resolve(webRoot, "..");
const specPath = join(repoRoot, "docs/static/frigate-api.yaml");
const outPath = join(webRoot, "src/types/fork/api.gen.ts");
const check = process.argv.includes("--check");

const banner = `${COMMENT_HEADER}// Source: docs/static/frigate-api.yaml\n// Regenerate: (cd web && npm run api-types)\n\n`;

const ast = await openapiTS(new URL(`file://${specPath}`));
const next = `${banner}${astToString(ast)}`;

if (check) {
  let current = "";
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    console.error(
      `missing ${relative(repoRoot, outPath)}; run npm run api-types`,
    );
    process.exit(1);
  }
  if (current !== next) {
    console.error(
      `${relative(repoRoot, outPath)} is stale. Run:\n  (cd web && npm run api-types)`,
    );
    process.exit(1);
  }
  process.exit(0);
}

writeFileSync(outPath, next);
console.log(`wrote ${relative(repoRoot, outPath)} (${next.length} bytes)`);
