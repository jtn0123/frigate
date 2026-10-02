#!/usr/bin/env node
/** Merge browser execution coverage with Vitest using original source locations. */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeProcessCovs } from "@bcoe/v8-coverage";
import { convert } from "ast-v8-to-istanbul";
import { parseAstAsync } from "rollup/parseAst";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { creditFoldedStatements } from "./browser-coverage-statements.mjs";

/**
 * Istanbul coverage for one built asset (`converted`) and the statements its
 * minified code folded together (`folded`); both empty when it maps no app
 * source.
 */
async function convertAsset(entry, asset, baseline) {
  const sourceMap = JSON.parse(await readFile(asset + ".map", "utf8"));
  if (!sourceMap.sources.some((source) => source.includes("/src/")))
    return { converted: {}, folded: [] };
  const code = await readFile(asset, "utf8");
  const assetUrl = pathToFileURL(asset).href;
  const converted = await convert({
    ast: parseAstAsync(code),
    code,
    wrapperLength: 0,
    sourceMap,
    coverage: { ...entry, url: assetUrl },
  });
  const folded = creditFoldedStatements({
    code,
    sourceMap,
    assetUrl,
    functions: entry.functions,
    baseline,
    converted,
  });
  return { converted, folded };
}

export async function mergeBrowserCoverage(webRoot) {
  const root = resolve(webRoot);
  const dist = resolve(root, "dist");
  const coverage = resolve(root, "coverage");
  const raw = resolve(root, "coverage-browser");
  const names = (await readdir(raw, { recursive: true })).filter((name) =>
    name.endsWith(".json"),
  );
  if (names.length === 0) throw new Error("No browser coverage was captured");
  const inputs = await Promise.all(
    names.map(async (name) =>
      JSON.parse(await readFile(resolve(raw, name), "utf8")),
    ),
  );
  const unitReport = await readFile(
    resolve(coverage, "coverage-final.json"),
    "utf8",
  );
  const merged = libCoverage.createCoverageMap(JSON.parse(unitReport));
  // A separate copy: merging rewrites the statement maps of `merged` in place.
  const baseline = JSON.parse(unitReport);
  const entries = mergeProcessCovs(inputs).result.map((entry) => {
    const asset = resolve(dist, "." + entry.url);
    if (!asset.startsWith(dist + sep) || !asset.endsWith(".js"))
      throw new Error("Invalid browser coverage asset path");
    return { entry, asset };
  });
  // Each asset converts on its own; the results merge below in input order,
  // so the report is the same as converting one asset at a time.
  const results = await Promise.all(
    entries.map(({ entry, asset }) => convertAsset(entry, asset, baseline)),
  );
  let measured = 0;
  for (const { converted: files, folded } of results) {
    for (const [file, data] of Object.entries(files)) {
      if (file.startsWith(resolve(root, "src") + sep)) {
        merged.addFileCoverage(data);
        measured += 1;
      }
    }
    for (const data of folded) merged.addFileCoverage(data);
  }
  if (!measured)
    throw new Error("Browser coverage did not map to application sources");
  reports
    .create("lcovonly")
    .execute(libReport.createContext({ dir: coverage, coverageMap: merged }));
  await writeFile(
    resolve(coverage, "coverage-final.json"),
    JSON.stringify(merged.toJSON()),
  );
  return { tests: names.length, mappedFiles: measured };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  console.log(await mergeBrowserCoverage(root));
}
