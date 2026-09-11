#!/usr/bin/env node
/**
 * Fail if the gzip size of eagerly loaded JS/CSS exceeds fork/bundle-budget.json.
 *
 * Counts unique script src, modulepreload, and stylesheet hrefs in dist/index.html.
 */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const repoRoot = resolve(webRoot, "..");
const distDir = join(webRoot, "dist");
const htmlPath = join(distDir, "index.html");
const budgetPath = join(repoRoot, "fork/bundle-budget.json");

const html = readFileSync(htmlPath, "utf8");
const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
const limit = Number(budget.eagerGzipBytes);
if (!Number.isFinite(limit) || limit <= 0) {
  console.error("fork/bundle-budget.json must set eagerGzipBytes > 0");
  process.exit(2);
}

const hrefs = new Set();
for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) {
  hrefs.add(m[1]);
}
for (const m of html.matchAll(
  /<link\b[^>]*\brel="(?:modulepreload|stylesheet)"[^>]*\bhref="([^"]+)"/gi,
)) {
  hrefs.add(m[1]);
}
for (const m of html.matchAll(
  /<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="(?:modulepreload|stylesheet)"/gi,
)) {
  hrefs.add(m[1]);
}

function resolveAsset(href) {
  const clean = href.split("?")[0].replace(/^\//, "");
  const stripped = clean.replace(/^BASE_PATH\//, "");
  return join(distDir, stripped);
}

const rows = [];
let total = 0;
for (const href of [...hrefs].sort()) {
  if (!/\.(js|css)$/i.test(href.split("?")[0])) {
    continue;
  }
  const file = resolveAsset(href);
  let raw;
  try {
    raw = readFileSync(file);
  } catch {
    console.error(`missing eager asset: ${href} (${file})`);
    process.exit(2);
  }
  const gzip = gzipSync(raw, { level: 9 }).length;
  rows.push({ href, raw: raw.length, gzip });
  total += gzip;
}

const col = (s, n) => String(s).padEnd(n);
console.log(`${col("asset", 48)} ${col("raw", 10)} gzip`);
for (const r of rows) {
  const name = r.href.split("/").pop();
  console.log(`${col(name, 48)} ${col(r.raw, 10)} ${r.gzip}`);
}
console.log(
  `${col("total", 48)} ${col("", 10)} ${total} / ${limit} (${budget.note ?? ""})`,
);

if (total > limit) {
  console.error(
    `eager gzip ${total} exceeds budget ${limit}. Raise fork/bundle-budget.json only with a sentence in the commit explaining why.`,
  );
  process.exit(1);
}
