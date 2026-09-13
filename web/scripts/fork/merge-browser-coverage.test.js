import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeBrowserCoverage } from "./merge-browser-coverage.mjs";
const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "browser-coverage-test-"));
  roots.push(root);
  for (const dir of ["src", "dist/assets", "coverage", "coverage-browser"])
    await mkdir(join(root, dir), { recursive: true });
  const code = "export function answer() { return 42; }\nanswer();\n";
  const file = join(root, "src/example.ts");
  await writeFile(file, code);
  await writeFile(join(root, "dist/assets/app.js"), code);
  await writeFile(
    join(root, "dist/assets/app.js.map"),
    JSON.stringify({
      version: 3,
      sources: ["../../src/example.ts"],
      sourcesContent: [code],
      names: [],
      mappings: "AAAA;AACA",
    }),
  );
  await writeFile(
    join(root, "coverage/coverage-final.json"),
    JSON.stringify({
      [file]: {
        path: file,
        statementMap: {
          0: { start: { line: 2, column: 0 }, end: { line: 2, column: 9 } },
        },
        s: { 0: 0 },
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
    }),
  );
  const unloaded = join(root, "src/unloaded.ts");
  await writeFile(unloaded, code);
  const reportPath = join(root, "coverage/coverage-final.json");
  const baseline = JSON.parse(await readFile(reportPath, "utf8"));
  baseline[unloaded] = { ...baseline[file], path: unloaded };
  await writeFile(reportPath, JSON.stringify(baseline));
  return { root, file, code, unloaded };
}
async function capture(root, code, url = "/assets/app.js") {
  await writeFile(
    join(root, "coverage-browser/test.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url,
          functions: [
            {
              functionName: "",
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }],
            },
          ],
        },
      ],
    }),
  );
}
it("maps real execution to original source and retains uncovered unit evidence", async () => {
  const { root, file, code, unloaded } = await fixture();
  await capture(root, code);
  expect(await mergeBrowserCoverage(root)).toEqual({
    tests: 1,
    mappedFiles: 1,
  });
  const report = await readFile(join(root, "coverage/lcov.info"), "utf8");
  expect(report).toContain("src/example.ts");
  const data = JSON.parse(
    await readFile(join(root, "coverage/coverage-final.json"), "utf8"),
  );
  expect(Object.values(data[file].s).some((count) => count > 0)).toBe(true);
  expect(Object.values(data[unloaded].s)).toEqual([0]);
});
it("rejects a missing browser report instead of silently claiming coverage", async () => {
  const { root } = await fixture();
  await expect(mergeBrowserCoverage(root)).rejects.toThrow(
    "No browser coverage",
  );
});
it("rejects assets outside the tested build", async () => {
  const { root, code } = await fixture();
  await capture(root, code, "/../outside.js");
  await expect(mergeBrowserCoverage(root)).rejects.toThrow(
    "Invalid browser coverage asset path",
  );
});
it("rejects captures that never mapped to application code", async () => {
  const { root, code } = await fixture();
  await capture(root, code);
  await writeFile(
    join(root, "dist/assets/app.js.map"),
    JSON.stringify({
      version: 3,
      sources: ["../../node_modules/library.js"],
      sourcesContent: [code],
      names: [],
      mappings: "AAAA;AACA",
    }),
  );
  await expect(mergeBrowserCoverage(root)).rejects.toThrow("did not map");
});
it("rejects missing source maps so a mismatched build cannot pass", async () => {
  const { root, code } = await fixture();
  await capture(root, code);
  await rm(join(root, "dist/assets/app.js.map"));
  await expect(mergeBrowserCoverage(root)).rejects.toThrow("ENOENT");
});
