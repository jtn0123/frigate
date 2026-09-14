#!/usr/bin/env node
/**
 * Automated audit of the running demo stack (fork/demo) as an Android phone.
 *
 * Signs in, visits every page (Live, each camera, Review, Explore, Export,
 * every Settings section, each System tab, Logs, Config, Faces,
 * Classification) and records, per page:
 *
 * - console errors/warnings, Chrome's own warnings (the Log domain, which
 *   Playwright's console event misses) and uncaught exceptions
 * - failed requests and HTTP errors
 * - axe-core WCAG 2.1 AA violations
 * - horizontal overflow at phone width, tap targets under 24/40 px, and
 *   images that finished loading with no pixels
 * - request storms: any URL pattern requested more than 8 times a second
 * - long tasks over 200 ms and cumulative layout shift
 * - the back button: each menu/drawer trigger is opened, back is pressed,
 *   and the overlay must close without leaving the page
 *
 * Writes report.md, results.json and screenshots to
 * fork/demo/.data/audit/<timestamp>/ (gitignored) and compares findings
 * with fork/demo/.data/audit/baseline-<profile>.json, so later runs show
 * only what is new or fixed. `--update-baseline` saves this run as the
 * baseline; `--strict` exits 1 when there are new findings.
 *
 * Usage (demo running, `make demo-up`):
 *   make demo-audit
 *   make demo-audit ARGS="--profile=desktop --update-baseline"
 *
 * axe-core is loaded from fork/demo/.data/tools (installed by the Make
 * target) so the web app's dependencies are not touched. The audit itself
 * is in phone-audit-lib.mjs; this file reads the options and the password.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { parseEnv, runAudit } from "./phone-audit-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const demoDir = join(webRoot, "../fork/demo");
const auditRoot = join(demoDir, ".data/audit");

const argValue = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const profile = argValue("profile", "phone");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const axePath =
  process.env.AXE_PATH ??
  join(demoDir, ".data/tools/node_modules/axe-core/axe.min.js");

const envPath = join(demoDir, ".env");
const env = {
  ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {}),
  ...process.env,
};
if (!env.FRIGATE_DEMO_PASSWORD) {
  console.error(
    "Set FRIGATE_DEMO_PASSWORD in fork/demo/.env (see make demo-logs).",
  );
  process.exit(2);
}
if (!existsSync(axePath)) {
  console.error(
    `axe-core not found at ${axePath}; run: npm --prefix fork/demo/.data/tools install axe-core@4`,
  );
  process.exit(2);
}

const { fresh, reportPath } = await runAudit({
  chromium,
  base: process.env.AUDIT_BASE ?? "https://127.0.0.1:8971",
  profile,
  dwellMs: Number(argValue("dwell", "5000")),
  user: env.FRIGATE_DEMO_USER || "admin",
  password: env.FRIGATE_DEMO_PASSWORD,
  axeSource: readFileSync(axePath, "utf8"),
  settingsSource: readFileSync(
    join(webRoot, "src/lib/fork/command-items.ts"),
    "utf8",
  ),
  outDir: join(auditRoot, `${stamp}-${profile}`),
  baselinePath: join(auditRoot, `baseline-${profile}.json`),
  stamp,
  updateBaseline: process.argv.includes("--update-baseline"),
});
console.log(`report: ${reportPath}`);
if (process.argv.includes("--strict") && fresh.length) process.exit(1);
