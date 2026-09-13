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
export const webRoot = resolve(here, "../..");
export const repoRoot = resolve(webRoot, "..");
export const specPath = join(repoRoot, "docs/static/frigate-api.yaml");
export const outPath = join(webRoot, "src/types/fork/api.gen.ts");

const banner = `${COMMENT_HEADER}// Source: docs/static/frigate-api.yaml\n// Regenerate: (cd web && npm run api-types)\n\n`;

/** Render the spec at `spec` as the contents of api.gen.ts. */
export async function renderTypes(spec = specPath) {
  const ast = await openapiTS(new URL(`file://${spec}`));
  return `${banner}${astToString(ast)}`;
}

/**
 * Write or verify the generated types.
 *
 * Returns `{ code, message }`: code 0 on success, 1 when `--check` finds the
 * file missing or stale. The CLI turns that into the process exit code.
 */
export async function run({
  check = false,
  spec = specPath,
  out = outPath,
} = {}) {
  const next = await renderTypes(spec);

  if (!check) {
    writeFileSync(out, next);
    return {
      code: 0,
      message: `wrote ${relative(repoRoot, out)} (${next.length} bytes)`,
    };
  }

  let current;
  try {
    current = readFileSync(out, "utf8");
  } catch {
    return {
      code: 1,
      message: `missing ${relative(repoRoot, out)}; run npm run api-types`,
    };
  }

  if (current !== next) {
    return {
      code: 1,
      message: `${relative(repoRoot, out)} is stale. Run:\n  (cd web && npm run api-types)`,
    };
  }

  return { code: 0, message: "" };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const { code, message } = await run({
    check: process.argv.includes("--check"),
  });
  if (message) {
    (code === 0 ? console.log : console.error)(message);
  }
  process.exit(code);
}
