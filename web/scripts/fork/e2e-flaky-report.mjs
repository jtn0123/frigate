#!/usr/bin/env node
/**
 * Fork: report the flaky tests in Playwright's JSON reports (item D49).
 *
 * CI runs with `retries: 1`, so a test that fails and then passes on the
 * retry leaves its shard green and nobody ever sees it. This reads the JSON
 * report each Playwright run wrote, prints one GitHub annotation per flaky
 * test, and with --strict exits non-zero, which is how pushes to `next` are
 * gated. A run with no report at all is an error: the json reporter is part
 * of the gate, so a missing file means the gate did not run.
 *
 *   node scripts/fork/e2e-flaky-report.mjs [reports-dir] [--strict]
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Every JSON report a Playwright run in this job may have written. */
const REPORT_FILE = /^results.*\.json$/;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Strip the color codes Playwright puts in `error.message`. */
function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

/** The first failed attempt's message, trimmed to one line. */
function firstError(test) {
  for (const result of test.results ?? []) {
    const message = result.error?.message;
    if (message) return plain(message).split("\n")[0].trim();
  }
  return "";
}

/**
 * The flaky tests in one parsed Playwright JSON report.
 *
 * @param {object} report The parsed report
 * @param {string} repoRoot Absolute path the annotated paths are relative to
 * @returns {{file: string, line: number, title: string, project: string,
 *   attempts: number, error: string}[]} One entry per flaky test
 */
export function flakyTests(report, repoRoot = REPO_ROOT) {
  const rootDir = report?.config?.rootDir ?? repoRoot;
  const found = [];
  const walk = (suite, titles) => {
    // The outermost suite is titled with its own file; only describe titles
    // are worth repeating in the annotation.
    const path =
      suite.title && suite.title !== suite.file
        ? [...titles, suite.title]
        : titles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status !== "flaky") continue;
        found.push({
          file: relative(repoRoot, resolve(rootDir, spec.file ?? "")),
          line: spec.line ?? 0,
          title: [...path, spec.title].filter(Boolean).join(" > "),
          project: test.projectName ?? "",
          attempts: (test.results ?? []).length,
          error: firstError(test),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, path);
  };
  for (const suite of report?.suites ?? []) walk(suite, []);
  return found;
}

/** Escape a workflow-command message (GitHub reads %, CR and LF). */
function escapeMessage(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * The GitHub annotation for one flaky test.
 *
 * @param {object} test One entry from flakyTests()
 * @param {boolean} strict Annotate as an error rather than a warning
 * @returns {string} A workflow command line
 */
export function annotation(test, strict) {
  const where = test.project ? ` [${test.project}]` : "";
  const attempts =
    test.attempts > 1 ? `, passed on attempt ${test.attempts}` : "";
  const why = test.error ? `: ${test.error}` : "";
  const message = escapeMessage(
    `Flaky e2e test${where}: ${test.title}${attempts}${why}`,
  );
  return (
    `::${strict ? "error" : "warning"} file=${test.file},` +
    `line=${test.line},title=Flaky e2e test::${message}`
  );
}

/** The report files in `dir`, in name order, parsed. */
export function readReports(dir) {
  return readdirSync(dir)
    .filter((name) => REPORT_FILE.test(name))
    .sort()
    .map((name) => ({
      name,
      report: JSON.parse(readFileSync(join(dir, name), "utf8")),
    }));
}

/**
 * Annotate every flaky test found under `dir`.
 *
 * @param {string} dir Directory holding the Playwright JSON reports
 * @param {{strict?: boolean, repoRoot?: string,
 *   log?: (line: string) => void}} options How to report
 * @returns {number} The process exit code
 */
export function run(dir, { strict = false, repoRoot = REPO_ROOT, log } = {}) {
  const write = log ?? ((line) => console.log(line));
  let reports;
  try {
    reports = readReports(dir);
  } catch {
    reports = [];
  }
  if (reports.length === 0) {
    write(
      `::error title=Flaky e2e tests::No Playwright JSON report in ${dir}; ` +
        "the json reporter did not run",
    );
    return 1;
  }
  const flaky = reports.flatMap(({ report }) => flakyTests(report, repoRoot));
  for (const test of flaky) write(annotation(test, strict));
  if (flaky.length === 0) {
    write(`No flaky e2e tests in ${reports.length} report(s)`);
    return 0;
  }
  const counted = `${flaky.length} flaky test(s) in ${reports.length} report(s)`;
  if (!strict) {
    write(`::notice title=Flaky e2e tests::${counted}`);
    return 0;
  }
  write(
    `::error title=Flaky e2e tests::${counted}; the retry hid them, so this ` +
      "run does not say whether the suite is green",
  );
  return 1;
}

function main(argv) {
  const strict = argv.includes("--strict");
  const dir = argv.find((arg) => !arg.startsWith("--")) ?? "test-results";
  return run(resolve(dir), { strict });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
