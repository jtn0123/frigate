#!/usr/bin/env node
/**
 * Fail CI when TypeScript escape hatches or type-aware lint findings grow.
 *
 * Counts live in fork/type-ratchet.json. A rise is a failure. A fall prints
 * the command to lower the baseline (`--write`) so the ratchet actually
 * tightens.
 *
 *   node scripts/fork/type-ratchet.mjs           # compare
 *   node scripts/fork/type-ratchet.mjs --write   # rewrite baselines to current
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const repoRoot = resolve(webRoot, "..");
const srcRoot = join(webRoot, "src");
const baselinePath = join(repoRoot, "fork/type-ratchet.json");
const write = process.argv.includes("--write");

const RULES = [
  "@typescript-eslint/no-floating-promises",
  "@typescript-eslint/no-misused-promises",
  "@typescript-eslint/no-unnecessary-condition",
  "@typescript-eslint/no-unsafe-member-access",
  "@typescript-eslint/no-unsafe-assignment",
  "@typescript-eslint/no-unsafe-return",
  "@typescript-eslint/no-unsafe-argument",
  "@typescript-eslint/no-unsafe-call",
  "@typescript-eslint/switch-exhaustiveness-check",
];

export function walkTs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "coverage") {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walkTs(path, out);
      continue;
    }
    if (name.endsWith(".d.ts")) {
      continue;
    }
    if (/\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

export function countHatches(source) {
  const tsExpectError = (source.match(/@ts-expect-error/g) ?? []).length;
  const asUnknownAs = (source.match(/\bas unknown as\b/g) ?? []).length;
  // Same matches as `(?:\s+[^\n]*)?` after the directive, but the whitespace
  // run must end before the first non-space character, so a long run of
  // spaces cannot be split between the two quantifiers in every possible way.
  const noExplicitAnyDisable = (
    source.match(
      /eslint-disable(?:-next-line)?(?:\s+(?:\S[^\n]*)?)?@typescript-eslint\/no-explicit-any/g,
    ) ?? []
  ).length;
  // Type-position `any`, not the English word in comments. Matches `: any`,
  // `as any`, `<any>`, `any[]`, `Promise<any>`, and similar.
  const explicitAny = (
    source.match(/(?::|\bas|<|,)\s*any\b|any\[\]|any>/g) ?? []
  ).length;
  return {
    explicitAny,
    tsExpectError,
    asUnknownAs,
    noExplicitAnyDisable,
  };
}

function addHatches(a, b) {
  return {
    explicitAny: a.explicitAny + b.explicitAny,
    tsExpectError: a.tsExpectError + b.tsExpectError,
    asUnknownAs: a.asUnknownAs + b.asUnknownAs,
    noExplicitAnyDisable: a.noExplicitAnyDisable + b.noExplicitAnyDisable,
  };
}

function scanHatches(root) {
  let totals = {
    explicitAny: 0,
    tsExpectError: 0,
    asUnknownAs: 0,
    noExplicitAnyDisable: 0,
  };
  for (const file of walkTs(root)) {
    totals = addHatches(totals, countHatches(readFileSync(file, "utf8")));
  }
  return totals;
}

function countRules() {
  const result = spawnSync(
    process.execPath,
    [
      join(webRoot, "node_modules/eslint/bin/eslint.js"),
      "-c",
      join(webRoot, "eslint.ratchet.config.js"),
      "--no-error-on-unmatched-pattern",
      "--format",
      "json",
      "src",
    ],
    { cwd: webRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) {
    throw result.error;
  }
  const stdout = result.stdout.trim();
  if (!stdout) {
    console.error(result.stderr);
    process.exit(result.status === 0 ? 2 : result.status);
  }
  let reports;
  try {
    reports = JSON.parse(stdout);
  } catch {
    console.error("eslint ratchet output was not JSON");
    console.error(result.stderr || stdout.slice(0, 2000));
    process.exit(2);
  }
  const rules = Object.fromEntries(RULES.map((name) => [name, 0]));
  for (const report of reports) {
    for (const msg of report.messages ?? []) {
      if (msg.ruleId && Object.hasOwn(rules, msg.ruleId)) {
        rules[msg.ruleId] += 1;
      }
    }
  }
  return rules;
}

function compare(kind, current, baseline) {
  const risen = [];
  const fallen = [];
  for (const key of Object.keys(baseline)) {
    const now = current[key] ?? 0;
    const was = baseline[key] ?? 0;
    const label = `${kind}.${key}`;
    if (now > was) {
      risen.push(`${label}: ${was} -> ${now}`);
    } else if (now < was) {
      fallen.push(`${label}: ${was} -> ${now}`);
    }
  }
  return { risen, fallen };
}

function printTable(title, current, baseline) {
  console.log(title);
  for (const key of Object.keys(baseline)) {
    const now = current[key] ?? 0;
    const was = baseline[key] ?? 0;
    let delta = "";
    if (now > was) {
      delta = `  UP from ${was}`;
    } else if (now < was) {
      delta = `  down from ${was}`;
    }
    console.log(`  ${key}: ${now}${delta}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const hatches = scanHatches(srcRoot);
  const rules = countRules();
  const current = { hatches, rules };

  if (write) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`wrote ${relative(repoRoot, baselinePath)}`);
    printTable("hatches", hatches, hatches);
    printTable("rules", rules, rules);
    process.exit(0);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    console.error(
      `missing ${relative(repoRoot, baselinePath)}. Run with --write to create it.`,
    );
    process.exit(2);
  }

  printTable("hatches", hatches, baseline.hatches);
  printTable("rules", rules, baseline.rules);

  const hatchDiff = compare("hatches", hatches, baseline.hatches);
  const ruleDiff = compare("rules", rules, baseline.rules);
  const risen = [...hatchDiff.risen, ...ruleDiff.risen];
  const fallen = [...hatchDiff.fallen, ...ruleDiff.fallen];

  if (fallen.length) {
    console.log(
      "\nCounts fell. Tighten the baseline:\n  (cd web && node scripts/fork/type-ratchet.mjs --write)",
    );
    for (const line of fallen) {
      console.log(`  ${line}`);
    }
  }
  if (risen.length) {
    console.error("\nType ratchet failed; counts rose:");
    for (const line of risen) {
      console.error(`  ${line}`);
    }
    process.exit(1);
  }
}
