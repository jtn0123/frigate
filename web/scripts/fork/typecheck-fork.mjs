#!/usr/bin/env node
/**
 * Run tsc with tsconfig.fork-strict.json and fail only on diagnostics in
 * fork paths. Extra flags apply to those files; imported upstream modules
 * are typechecked as dependencies and their errors are ignored.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const result = spawnSync(
  join(webRoot, "node_modules/typescript/bin/tsc"),
  [
    "-p",
    "tsconfig.fork-strict.json",
    "--pretty",
    "false",
    "--noEmit",
    "--incremental",
    "--tsBuildInfoFile",
    ".cache/tsc/fork-strict.tsbuildinfo",
  ],
  { cwd: webRoot, encoding: "utf8" },
);

const output = `${result.stdout}${result.stderr}`;
const forkHit = (line) =>
  /[/\\]fork[/\\]/.test(line) || /e2e[/\\]specs[/\\]fork[/\\]/.test(line);

const forkLines = output
  .split("\n")
  .filter((line) => line.includes(": error TS") && forkHit(line));

if (forkLines.length) {
  console.error(forkLines.join("\n"));
  console.error(
    `\n${forkLines.length} error(s) in fork paths (${relative(webRoot, "tsconfig.fork-strict.json")})`,
  );
  process.exit(1);
}

if (result.status !== 0 && !output.includes(": error TS")) {
  console.error(output);
  process.exit(result.status ?? 2);
}
