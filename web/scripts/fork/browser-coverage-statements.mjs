/**
 * Credit source statements that the minifier folded into another statement.
 *
 * ast-v8-to-istanbul counts the statements of the generated (built) code. The
 * production build minifies, which folds consecutive source statements into
 * one sequence expression (`a(); b();` becomes `a(),b();`) and turns an `if`
 * block into a conditional expression. Only the first source statement of
 * such a run keeps a statement of its own, so every later one had no browser
 * statement at all, and Sonar showed it with Vitest's zero even though the e2e
 * suite ran it (I64).
 *
 * For each statement of the Vitest report (which counts the original source),
 * this looks up where its first token landed in the built asset through the
 * source map and reads the V8 count of the innermost range around that byte.
 * A statement whose start has no mapping on its own line is left alone, and so
 * is a `return` the minifier may have merged with another (generatedOffset).
 *
 * That count is capped by the count at the start of the innermost generated
 * statement around the byte: a statement that never started ran none of its
 * parts. V8 needs the cap because it cuts some block ranges short. In
 * `if(!r)return 0;let o=0;return r.length>=8&&(o+=1),f(r)&&(o+=1),o` the
 * never-run range after the early return ends at the first `&&(o+=1)`, so the
 * bytes after it read the function's count, though none of them ran.
 */
import { fileURLToPath } from "node:url";
import { parseAst } from "rollup/parseAst";
import {
  LEAST_UPPER_BOUND,
  TraceMap,
  generatedPositionFor,
  originalPositionFor,
  sourceContentFor,
} from "@jridgewell/trace-mapping";

/** Non-overlapping segments carrying the count of the innermost V8 range. */
export function flattenRanges(functions) {
  const ranges = functions
    .flatMap((fn) => fn.ranges)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const segments = [];
  const stack = [];
  let position = 0;
  const emitTo = (end) => {
    if (stack.length && end > position)
      segments.push({ start: position, end, count: stack.at(-1).count });
    position = Math.max(position, end);
  };
  // The innermost open range owns the bytes up to its end, then is closed.
  const close = () => {
    emitTo(stack.at(-1).endOffset);
    stack.pop();
  };
  for (const range of ranges) {
    while (stack.length && stack.at(-1).endOffset <= range.startOffset) close();
    emitTo(range.startOffset);
    stack.push(range);
  }
  while (stack.length) close();
  return segments;
}

/** V8 count at a byte offset, or null outside every range. */
export function countAt(segments, offset) {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (offset < segment.start) high = mid - 1;
    else if (offset >= segment.end) low = mid + 1;
    else return segment.count;
  }
  return null;
}

function lineOffsets(code) {
  const offsets = [0];
  for (let index = code.indexOf("\n"); index !== -1;) {
    offsets.push(index + 1);
    index = code.indexOf("\n", index + 1);
  }
  return offsets;
}

/** Every statement of the built code, as a V8-style range. */
function statementRanges(node, ranges = []) {
  if (Array.isArray(node)) {
    for (const child of node) statementRanges(child, ranges);
  } else if (node && typeof node.type === "string") {
    if (
      /(Statement|Declaration)$/.test(node.type) &&
      node.type !== "BlockStatement"
    )
      ranges.push({ startOffset: node.start, endOffset: node.end });
    for (const value of Object.values(node))
      if (value && typeof value === "object") statementRanges(value, ranges);
  }
  return ranges;
}

/** Segments that resolve a byte to the start of its innermost statement. */
function statementStarts(code) {
  const ranges = statementRanges(parseAst(code)).map((range) => ({
    ...range,
    count: range.startOffset,
  }));
  return flattenRanges([{ ranges }]);
}

function locationKey(loc) {
  return `${loc.start.line}:${loc.start.column}:${loc.end.line}:${loc.end.column}`;
}

/**
 * Generated offset of a statement's first token, or null if unmapped.
 *
 * A dropped `return` keyword means the return became an arm of a conditional,
 * and the minifier merges equal arms: both `return false;` of
 * `if (a) return false; if (b) return false;` become the one `!1` of
 * `a||b?!1:...`, mapped to only one of them. Such a statement is left out.
 */
function generatedOffset(map, source, loc, starts, lines) {
  const generated = generatedPositionFor(map, {
    source,
    line: loc.start.line,
    column: loc.start.column,
    bias: LEAST_UPPER_BOUND,
  });
  if (generated.line == null) return null;
  // The mapping found must still be inside the statement, on its first line.
  const back = originalPositionFor(map, generated);
  if (back.source !== source || back.line !== loc.start.line) return null;
  // Vitest writes an end column of Infinity (to the end of the line) as null.
  const end = loc.end.column ?? Infinity;
  if (loc.start.line === loc.end.line && back.column >= end) return null;
  const skipped = lines?.[loc.start.line - 1]?.slice(
    loc.start.column,
    back.column,
  );
  if (skipped == null || /^return\b/.test(skipped)) return null;
  return starts[generated.line - 1] + generated.column;
}

/**
 * Statement-only Istanbul coverage for the source files of one asset.
 *
 * @param {object} options
 * @param {string} options.code built asset source
 * @param {object} options.sourceMap the asset's source map
 * @param {string} options.assetUrl file URL of the asset (resolves sources)
 * @param {Array} options.functions merged V8 function coverage of the asset
 * @param {object} options.baseline Vitest coverage data keyed by file path
 * @param {object} options.converted ast-v8-to-istanbul output for the asset
 * @returns {object[]} file coverage objects, one per credited source file
 */
export function creditFoldedStatements({
  code,
  sourceMap,
  assetUrl,
  functions,
  baseline,
  converted,
}) {
  const map = new TraceMap(sourceMap, assetUrl);
  const segments = flattenRanges(functions);
  const statements = statementStarts(code);
  const starts = lineOffsets(code);
  const countFor = (offset) => {
    const count = countAt(segments, offset);
    if (!count) return 0;
    const start = countAt(statements, offset);
    return start == null
      ? count
      : Math.min(count, countAt(segments, start) ?? 0);
  };
  const credited = [];
  map.resolvedSources.forEach((resolved) => {
    if (!resolved?.startsWith("file:")) return;
    const file = fileURLToPath(resolved);
    const unit = baseline[file];
    if (!unit) return;
    const lines = sourceContentFor(map, resolved)?.split("\n");
    const measured = new Set(
      Object.values(converted[file]?.statementMap ?? {}).map(locationKey),
    );
    const statementMap = {};
    const s = {};
    for (const [id, loc] of Object.entries(unit.statementMap)) {
      if (measured.has(locationKey(loc))) continue;
      const offset = generatedOffset(map, resolved, loc, starts, lines);
      const count = offset == null ? 0 : countFor(offset);
      if (!count) continue;
      statementMap[id] = loc;
      s[id] = count;
    }
    if (Object.keys(s).length)
      credited.push({
        path: file,
        statementMap,
        s,
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      });
  });
  return credited;
}
