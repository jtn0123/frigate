import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countAt, flattenRanges } from "./browser-coverage-statements.mjs";
import { mergeBrowserCoverage } from "./merge-browser-coverage.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const range = (startOffset, endOffset, count) => ({
  startOffset,
  endOffset,
  count,
});

describe("flattenRanges", () => {
  it("gives every byte the count of its innermost range", () => {
    const segments = flattenRanges([
      { ranges: [range(0, 100, 1), range(20, 40, 0)] },
      { ranges: [range(50, 90, 3), range(60, 70, 0)] },
    ]);
    expect(
      [5, 25, 45, 55, 65, 85, 95].map((at) => countAt(segments, at)),
    ).toEqual([1, 0, 1, 3, 0, 3, 1]);
  });

  it("reports bytes outside every range as unmeasured", () => {
    const segments = flattenRanges([{ ranges: [range(10, 20, 2)] }]);
    expect(countAt(segments, 5)).toBeNull();
    expect(countAt(segments, 20)).toBeNull();
    expect(countAt(segments, 19)).toBe(2);
  });
});

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(value) {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest) digit |= 32;
    out += BASE64[digit];
  } while (rest);
  return out;
}
/** One generated line; each segment is [generated column, line, column]. */
function mappings(segments) {
  let previous = [0, 0, 0];
  return segments
    .map(([column, line, sourceColumn]) => {
      const encoded =
        vlq(column - previous[0]) +
        vlq(0) +
        vlq(line - previous[1]) +
        vlq(sourceColumn - previous[2]);
      previous = [column, line, sourceColumn];
      return encoded;
    })
    .join(",");
}

/**
 * A built asset, its source map, Vitest's report and one browser capture.
 *
 * `segments` maps a token of `built` to a 1-based source line and column;
 * `statements` are the Vitest statement starts (1-based line, column), every
 * one unexecuted by the unit tests and ending at the end of its line like
 * Vitest's real report (an end column of null); `ranges` are V8 ranges as
 * [first token, token after the end (or null for the end), count].
 */
async function writeFixture({ source, built, segments, statements, ranges }) {
  const root = await mkdtemp(join(tmpdir(), "browser-coverage-fold-"));
  roots.push(root);
  for (const dir of ["src", "dist/assets", "coverage", "coverage-browser"])
    await mkdir(join(root, dir), { recursive: true });
  const file = join(root, "src/fold.ts");
  const at = (token) => {
    const offset = built.indexOf(token);
    if (offset === -1) throw new Error(`no ${token} in the built code`);
    return offset;
  };
  await writeFile(file, source);
  await writeFile(join(root, "dist/assets/app.js"), built);
  await writeFile(
    join(root, "dist/assets/app.js.map"),
    JSON.stringify({
      version: 3,
      sources: ["../../src/fold.ts"],
      sourcesContent: [source],
      names: [],
      mappings: mappings(
        segments.map(([token, line, column]) => [at(token), line - 1, column]),
      ),
    }),
  );
  const statementMap = Object.fromEntries(
    statements.map(([line, column], index) => [
      index,
      { start: { line, column }, end: { line, column: null } },
    ]),
  );
  await writeFile(
    join(root, "coverage/coverage-final.json"),
    JSON.stringify({
      [file]: {
        path: file,
        statementMap,
        s: Object.fromEntries(statements.map((_, index) => [index, 0])),
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
    }),
  );
  await writeFile(
    join(root, "coverage-browser/test.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: "/assets/app.js",
          functions: ranges.map(([start, end, count]) => ({
            functionName: "",
            isBlockCoverage: true,
            ranges: [range(at(start), end ? at(end) : built.length, count)],
          })),
        },
      ],
    }),
  );
  return root;
}

async function lineHits(root) {
  await mergeBrowserCoverage(root);
  const report = await readFile(join(root, "coverage/lcov.info"), "utf8");
  return Object.fromEntries(
    [...report.matchAll(/^DA:(\d+),(\d+)$/gm)].map(([, line, hits]) => [
      Number(line),
      Number(hits),
    ]),
  );
}

// What the minifier does to two statements in a row: one sequence expression.
const FOLDED = {
  source: [
    "export function run() {",
    "  first();",
    "  second();",
    "}",
    "export function never() {",
    "  third();",
    "  fourth();",
    "}",
    "run();",
  ].join("\n"),
  built:
    "function run(){first(),second()}function never(){third(),fourth()}run();",
  segments: [
    ["function run", 1, 0],
    ["first", 2, 2],
    ["second", 3, 2],
    ["}function never", 4, 0],
    ["function never", 5, 0],
    ["third", 6, 2],
    ["fourth", 7, 2],
    ["}run", 8, 0],
    ["run();", 9, 0],
  ],
  statements: [
    [2, 2],
    [3, 2],
    [6, 2],
    [7, 2],
    [9, 0],
  ],
  ranges: [
    ["function run", null, 1],
    ["function run", "function never", 1],
    ["function never", "run();", 0],
  ],
};

describe("statements the minifier folded together", () => {
  it("credits every executed source statement, not only the first", async () => {
    const hits = await lineHits(await writeFixture(FOLDED));
    expect(hits[2]).toBeGreaterThan(0);
    expect(hits[3]).toBeGreaterThan(0);
    expect(hits[9]).toBeGreaterThan(0);
  });

  it("leaves statements of a function that never ran at zero", async () => {
    const hits = await lineHits(await writeFixture(FOLDED));
    expect(hits[6]).toBe(0);
    expect(hits[7]).toBe(0);
  });

  it("does not credit a statement whose start has no mapping", async () => {
    // Only the first statement of the run keeps a mapping of its own.
    const hits = await lineHits(
      await writeFixture({
        ...FOLDED,
        segments: FOLDED.segments.filter(([token]) => token !== "second"),
      }),
    );
    expect(hits[2]).toBeGreaterThan(0);
    expect(hits[3] ?? 0).toBe(0);
  });

  it("caps a statement by the statement it was folded into", async () => {
    // V8 ends the never-run range after the early return at the first
    // `&&(s+=1)`, so the bytes after it read the function's count of 1.
    const hits = await lineHits(
      await writeFixture({
        source: [
          "export function strength(p) {",
          "  if (!p) return 0;",
          "  let s = 0;",
          "  if (p.length > 8) s += 1;",
          "  if (/\\d/.test(p)) s += 1;",
          "  return s;",
          "}",
          'strength("");',
        ].join("\n"),
        built:
          'function strength(p){if(!p)return 0;let s=0;return p.length>8&&(s+=1),/\\d/.test(p)&&(s+=1),s}strength("");',
        segments: [
          ["function strength", 1, 0],
          ["if(!p)", 2, 2],
          ["return 0", 2, 10],
          ["let s", 3, 2],
          ["return p", 6, 2],
          ["p.length", 4, 6],
          ["(s+=1),/", 4, 20],
          ["/\\d/", 5, 6],
          ["(s+=1),s", 5, 20],
          ["s}", 6, 9],
          ['strength("")', 8, 0],
        ],
        statements: [
          [2, 2],
          [2, 10],
          [3, 2],
          [4, 2],
          [4, 20],
          [5, 2],
          [5, 20],
          [6, 2],
          [8, 0],
        ],
        ranges: [
          ["function strength", null, 1],
          ["function strength", 'strength("")', 1],
          ["let s", ",/", 0],
          ["&&(s+=1),/", ",/", 0],
          ["&&(s+=1),s", ",s}", 0],
        ],
      }),
    );
    expect(hits[2]).toBeGreaterThan(0);
    expect(hits[5]).toBe(0);
    expect(hits[6]).toBe(0);
  });

  it("does not credit a return the minifier merged with another", async () => {
    // Both `return false` became the one `!1`, mapped to the first only.
    const hits = await lineHits(
      await writeFixture({
        source: [
          "export function pick(a, b) {",
          "  if (a) {",
          "    return false;",
          "  }",
          "  if (b) {",
          "    return false;",
          "  }",
          "  return true;",
          "}",
          "pick(false, true);",
        ].join("\n"),
        built: "function pick(a,b){return a||b?!1:!0}pick(!1,!0);",
        segments: [
          ["function pick", 1, 0],
          ["return a", 2, 2],
          ["a||b", 2, 6],
          ["b?", 5, 6],
          ["!1:", 3, 11],
          ["!0}", 8, 9],
          ["pick(!1", 10, 0],
        ],
        statements: [
          [2, 2],
          [3, 4],
          [5, 2],
          [6, 4],
          [8, 2],
          [10, 0],
        ],
        ranges: [
          ["function pick", null, 1],
          ["function pick", "pick(!1", 1],
          ["!0}", "}pick", 0],
        ],
      }),
    );
    expect(hits[3]).toBe(0);
    expect(hits[5]).toBeGreaterThan(0);
    expect(hits[8]).toBe(0);
  });
});
