#!/usr/bin/env node
/**
 * Validate JSON fixtures in web/e2e/fixtures/mock-data against the OpenAPI
 * 200 schemas. Unmapped *.json files fail so a new fixture cannot skip the
 * check. Two files are skipped with a documented reason: review-summary
 * (spec shape != the day-keyed payload the UI uses; do not reshape until
 * B2) and config-schema (JSON Schema for the editor, not an API list).
 *
 *   node e2e/scripts/validate-fixtures.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { load as loadYaml } from "js-yaml";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const repoRoot = resolve(webRoot, "..");
const defaultFixtureDir = join(webRoot, "e2e/fixtures/mock-data");
const defaultSpecPath = join(repoRoot, "docs/static/frigate-api.yaml");
const SPEC_ID = "https://frigate.local/openapi.json";

/**
 * Filename -> spec route, or a skip with a reason. Every *.json under
 * mock-data must appear here.
 *
 * @type {Record<string, {path: string, method?: string} | {skip: true, reason: string}>}
 */
export const FIXTURE_MAP = {
  "reviews.json": { path: "/review" },
  "events.json": { path: "/events" },
  "exports.json": { path: "/exports" },
  "cases.json": { path: "/cases" },
  "config-snapshot.json": { path: "/config" },
  "review-summary.json": {
    skip: true,
    reason:
      "Fixture is the day-keyed ReviewSummary the UI uses; spec ReviewSummaryResponse is { last24Hours, root }. Do not reshape the fixture. B2.",
  },
  "config-schema.json": {
    skip: true,
    reason:
      "Fixture is the JSON Schema document for the config editor, not a typed API list payload. Spec 200 is empty.",
  },
};

/**
 * Rewrite local OpenAPI pointers so Ajv can resolve them against the
 * registered spec document.
 *
 * @param {unknown} node
 * @returns {unknown}
 */
export function rewriteRefs(node) {
  if (Array.isArray(node)) {
    return node.map(rewriteRefs);
  }
  if (node !== null && typeof node === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (
        key === "$ref" &&
        typeof value === "string" &&
        value.startsWith("#/")
      ) {
        out[key] = `${SPEC_ID}${value}`;
      } else {
        out[key] = rewriteRefs(value);
      }
    }
    return out;
  }
  return node;
}

/**
 * FastAPI fixtures use ISO-8601 without a timezone. RFC 3339 date-time
 * (what ajv-formats ships) would reject them.
 *
 * @param {string} value
 */
function isDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * @param {unknown} spec
 */
export function createAjv(spec) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateSchema: false,
  });
  addFormats(ajv);
  ajv.addFormat("date-time", isDateTime);
  ajv.addSchema({
    $id: SPEC_ID,
    components: rewriteRefs(
      spec && typeof spec === "object" && "components" in spec
        ? spec.components
        : {},
    ),
  });
  return ajv;
}

/**
 * @param {unknown} spec
 * @param {string} path
 * @param {string} method
 */
export function responseSchema(spec, path, method) {
  if (!spec || typeof spec !== "object" || !("paths" in spec)) {
    throw new Error("OpenAPI spec is missing paths");
  }
  const paths = /** @type {Record<string, Record<string, unknown>>} */ (
    spec.paths
  );
  const operation = paths[path]?.[method];
  if (!operation || typeof operation !== "object") {
    throw new Error(`spec has no ${method.toUpperCase()} ${path}`);
  }
  const responses =
    "responses" in operation &&
    operation.responses &&
    typeof operation.responses === "object"
      ? /** @type {Record<string, { content?: { "application/json"?: { schema?: unknown } } }>} */ (
          operation.responses
        )
      : undefined;
  const schema = responses?.["200"]?.content?.["application/json"]?.schema;
  if (schema === undefined) {
    throw new Error(
      `spec has no application/json 200 schema for ${method.toUpperCase()} ${path}`,
    );
  }
  return schema;
}

/**
 * @param {import("ajv").ErrorObject[] | null | undefined} errors
 */
function formatAjvErrors(errors) {
  if (!errors?.length) {
    return "payload does not match the spec schema";
  }
  return errors
    .map((err) => {
      const where = err.instancePath || "/";
      return `${where} ${err.message ?? "is invalid"}`;
    })
    .join("; ");
}

/**
 * @typedef {{
 *   file: string,
 *   status: "pass" | "skip" | "fail",
 *   errors: string[],
 *   reason?: string,
 * }} FixtureResult
 */

/**
 * @typedef {{
 *   fixtureDir?: string,
 *   specPath?: string,
 *   spec?: unknown,
 *   extraFiles?: string[],
 *   payloads?: Record<string, unknown>,
 * }} ValidateOptions
 */

/**
 * @param {ValidateOptions} [options]
 * @returns {{ ok: boolean, results: FixtureResult[] }}
 */
export function validateFixtures(options = {}) {
  const fixtureDir = options.fixtureDir ?? defaultFixtureDir;
  const spec =
    options.spec ??
    loadYaml(readFileSync(options.specPath ?? defaultSpecPath, "utf8"));
  const onDisk = readdirSync(fixtureDir).filter((name) =>
    name.endsWith(".json"),
  );
  const files = [...new Set([...onDisk, ...(options.extraFiles ?? [])])].sort();
  const ajv = createAjv(spec);
  /** @type {FixtureResult[]} */
  const results = [];

  for (const file of files) {
    const mapping = FIXTURE_MAP[file];
    if (!mapping) {
      results.push({
        file,
        status: "fail",
        errors: [
          `unmapped JSON fixture; add it to FIXTURE_MAP in e2e/scripts/validate-fixtures.mjs`,
        ],
      });
      continue;
    }
    if ("skip" in mapping && mapping.skip) {
      results.push({
        file,
        status: "skip",
        errors: [],
        reason: mapping.reason,
      });
      continue;
    }

    const method = mapping.method ?? "get";
    try {
      const schema = rewriteRefs(responseSchema(spec, mapping.path, method));
      const validate = ajv.compile(schema);
      const payload =
        options.payloads?.[file] ??
        JSON.parse(readFileSync(join(fixtureDir, file), "utf8"));
      if (validate(payload)) {
        results.push({ file, status: "pass", errors: [] });
      } else {
        results.push({
          file,
          status: "fail",
          errors: [formatAjvErrors(validate.errors)],
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ file, status: "fail", errors: [message] });
    }
  }

  return {
    ok: results.every((row) => row.status !== "fail"),
    results,
  };
}

/**
 * @param {{ ok: boolean, results: FixtureResult[] }} report
 */
export function formatReport(report) {
  return report.results
    .map((row) => {
      if (row.status === "skip") {
        return `skip  ${row.file}: ${row.reason}`;
      }
      if (row.status === "fail") {
        return `fail  ${row.file}: ${row.errors.join("; ")}`;
      }
      return `ok    ${row.file}`;
    })
    .join("\n");
}

export function assertFixturesMatchSpec() {
  const report = validateFixtures();
  if (!report.ok) {
    throw new Error(
      `e2e fixtures do not match docs/static/frigate-api.yaml\n${formatReport(report)}`,
    );
  }
  return report;
}

function main() {
  const report = validateFixtures();
  console.log(formatReport(report));
  const failed = report.results.filter((row) => row.status === "fail");
  if (failed.length) {
    console.error(
      `\nvalidate-fixtures: ${failed.length} fixture${failed.length === 1 ? "" : "s"} failed`,
    );
    process.exit(1);
  }
  const skipped = report.results.filter((row) => row.status === "skip").length;
  console.log(
    `validate-fixtures: ${report.results.length} JSON fixtures (${skipped} skipped)`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
