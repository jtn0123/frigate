#!/usr/bin/env node
/**
 * Fail CI when TypeScript escape hatches or type-aware lint findings grow.
 *
 * Counts live in fork/type-ratchet.json. A rise is a failure. A fall prints
 * the command to lower the baseline (`--write`) so the ratchet actually
 * tightens.
 *
 * The baseline itself must not rise above the base branch's, or a change
 * could raise it to cover its own new hatches. The base is $TYPE_RATCHET_BASE
 * (default origin/next; empty skips this check); a base without a readable
 * baseline, such as one a shallow checkout lacks, is reported and skipped.
 *
 *   node scripts/fork/type-ratchet.mjs           # compare
 *   node scripts/fork/type-ratchet.mjs --write   # rewrite baselines to current
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

/** Baseline values higher than the base branch's, as `kind.key: was -> now`. */
export function raisedAbove(baseline, base) {
  const raised = [];
  for (const kind of ["hatches", "rules"]) {
    for (const [key, now] of Object.entries(baseline[kind] ?? {})) {
      // A count the base does not track yet (a new rule) has nothing to beat.
      const was = base?.[kind]?.[key];
      if (typeof was === "number" && now > was) {
        raised.push(`${kind}.${key}: ${was} -> ${now}`);
      }
    }
  }
  return raised;
}

// git from a fixed install location, not the first match on PATH (Sonar
// S4036); PATH is only the fallback where none of these exists.
const GIT_PATHS = [
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
];

function gitBinary() {
  return GIT_PATHS.find((path) => existsSync(path)) ?? "git";
}

/** The base branch's baseline, or why it cannot be read. */
function readBaseBaseline(ref) {
  if (!ref) {
    return { skipped: "TYPE_RATCHET_BASE is empty" };
  }
  // --end-of-options keeps a ref from $TYPE_RATCHET_BASE from being an option.
  const result = spawnSync(
    gitBinary(),
    ["show", "--end-of-options", `${ref}:fork/type-ratchet.json`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    return { skipped: `no fork/type-ratchet.json at ${ref}` };
  }
  try {
    return { base: JSON.parse(result.stdout) };
  } catch {
    return { skipped: `fork/type-ratchet.json at ${ref} is not JSON` };
  }
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
  const baseRef = process.env.TYPE_RATCHET_BASE ?? "origin/next";
  const { base, skipped } = readBaseBaseline(baseRef);
  const raised = base ? raisedAbove(baseline, base) : [];
  if (skipped) {
    console.log(`\nBaseline not compared with the base branch: ${skipped}.`);
  }

  if (risen.length) {
    console.error("\nType ratchet failed; counts rose:");
    for (const line of risen) {
      console.error(`  ${line}`);
    }
  }
  if (raised.length) {
    console.error(
      `\nType ratchet failed; the baseline rose above the one at ${baseRef}:`,
    );
    for (const line of raised) {
      console.error(`  ${line}`);
    }
  }
  if (risen.length || raised.length) {
    process.exit(1);
  }
}
