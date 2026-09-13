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
  const merged = libCoverage.createCoverageMap(
    JSON.parse(
      await readFile(resolve(coverage, "coverage-final.json"), "utf8"),
    ),
  );
  let measured = 0;
  for (const entry of mergeProcessCovs(inputs).result) {
    const asset = resolve(dist, "." + entry.url);
    if (!asset.startsWith(dist + sep) || !asset.endsWith(".js"))
      throw new Error("Invalid browser coverage asset path");
    const sourceMap = JSON.parse(await readFile(asset + ".map", "utf8"));
    if (!sourceMap.sources.some((source) => source.includes("/src/"))) continue;
    const code = await readFile(asset, "utf8");
    const converted = await convert({
      ast: parseAstAsync(code),
      code,
      wrapperLength: 0,
      sourceMap,
      coverage: { ...entry, url: pathToFileURL(asset).href },
    });
    for (const [file, data] of Object.entries(converted)) {
      if (file.startsWith(resolve(root, "src") + sep)) {
        merged.addFileCoverage(data);
        measured += 1;
      }
    }
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
