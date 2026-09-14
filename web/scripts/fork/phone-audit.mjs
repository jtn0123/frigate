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
 * with fork/demo/.data/audit/baseline.json, so later runs show only what is
 * new or fixed. `--update-baseline` saves this run as the baseline;
 * `--strict` exits 1 when there are new findings.
 *
 * Usage (demo running, `make demo-up`):
 *   make demo-audit
 *   make demo-audit ARGS="--profile=desktop --update-baseline"
 *
 * axe-core is loaded from fork/demo/.data/tools (installed by the Make
 * target) so the web app's dependencies are not touched.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const repoRoot = resolve(webRoot, "..");
const demoDir = join(repoRoot, "fork/demo");

const args = new Set(process.argv.slice(2));
const argValue = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = process.env.AUDIT_BASE ?? "https://127.0.0.1:8971";
const PROFILE = argValue("profile", "phone");
const DWELL_MS = Number(argValue("dwell", "5000"));
const AXE_PATH =
  process.env.AXE_PATH ??
  join(demoDir, ".data/tools/node_modules/axe-core/axe.min.js");
const auditRoot = join(demoDir, ".data/audit");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(auditRoot, `${stamp}-${PROFILE}`);
const baselinePath = join(auditRoot, `baseline-${PROFILE}.json`);

const PROFILES = {
  phone: {
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 3.5,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36",
  },
  desktop: { viewport: { width: 1440, height: 900 } },
};

// Findings that come from upstream Frigate or a fresh demo, not this UI
const KNOWN = [
  {
    pattern: /\/api\/preview\/.*404|404 .*\/api\/preview\//,
    why: "no preview files yet on a fresh demo",
  },
  {
    pattern: /\/api\/review\/event\/.*404|404 .*\/api\/review\/event\//,
    why: "object without a review item (upstream, see C5)",
  },
  {
    pattern:
      /Failed to load resource: the server responded with a status of 404/,
    why: "covered by the http entry for the same request",
  },
];

function readEnvFile() {
  const path = join(demoDir, ".env");
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
}

function settingsKeys() {
  const source = readFileSync(
    join(webRoot, "src/lib/fork/command-items.ts"),
    "utf8",
  );
  const block = source.slice(source.indexOf("export const SETTINGS_SECTIONS"));
  const end = block.indexOf("];");
  return [...block.slice(0, end).matchAll(/key: "([A-Za-z]+)"/g)].map(
    (m) => m[1],
  );
}

const env = { ...readEnvFile(), ...process.env };
const USER = env.FRIGATE_DEMO_USER || "admin";
const PASSWORD = env.FRIGATE_DEMO_PASSWORD;
if (!PASSWORD) {
  console.error(
    "Set FRIGATE_DEMO_PASSWORD in fork/demo/.env (see make demo-logs).",
  );
  process.exit(2);
}
if (!existsSync(AXE_PATH)) {
  console.error(
    `axe-core not found at ${AXE_PATH}; run: npm --prefix fork/demo/.data/tools install axe-core@4`,
  );
  process.exit(2);
}
const axeSource = readFileSync(AXE_PATH, "utf8");

// Injected into every document: long tasks and layout shift
const PERF_INIT = () => {
  window.__audit = { longTasks: [], cls: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration > 200)
          window.__audit.longTasks.push(Math.round(e.duration));
      }
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.hadRecentInput) window.__audit.cls += e.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    // Observer types unsupported: leave the defaults
  }
};

// Runs in the page: layout, tap targets and broken images
const LAYOUT_PROBE = (phone) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== "hidden" &&
      s.display !== "none" &&
      r.bottom > 0 &&
      r.top < innerHeight
    );
  };
  const label = (el) =>
    (
      el.getAttribute("aria-label") ||
      el.innerText ||
      el.getAttribute("title") ||
      el.tagName
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 50);
  const scroller = document.scrollingElement;
  const overflowing = [...document.querySelectorAll("body *")]
    .filter(
      (el) => visible(el) && el.getBoundingClientRect().right > innerWidth + 2,
    )
    .filter(
      (el) =>
        !el.closest(
          "[data-radix-scroll-area-viewport], .scrollbar-container, .overflow-x-auto, .overflow-auto",
        ),
    )
    .slice(0, 5)
    .map(
      (el) =>
        `${label(el)} (right ${Math.round(el.getBoundingClientRect().right)}px)`,
    );
  const interactive = [
    ...document.querySelectorAll(
      'button, a[href], [role="button"], [role="switch"], [role="tab"], [role="radio"], [role="checkbox"], input:not([type="hidden"]), select',
    ),
  ]
    .filter(visible)
    .filter((el) => !el.closest('[aria-hidden="true"]'));
  const small = [];
  const tiny = [];
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    const min = Math.min(r.width, r.height);
    if (min < 24)
      tiny.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    else if (phone && min < 40)
      small.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  const broken = [...document.images]
    .filter(
      (img) =>
        visible(img) && img.complete && img.naturalWidth === 0 && img.src,
    )
    .map((img) => img.src.replace(location.origin, ""))
    .slice(0, 5);
  return {
    pageOverflow:
      scroller.scrollWidth > innerWidth + 1
        ? scroller.scrollWidth - innerWidth
        : 0,
    overflowing,
    tinyTargets: tiny.slice(0, 8),
    tinyCount: tiny.length,
    smallTargets: small.slice(0, 8),
    smallCount: small.length,
    broken,
    perf: window.__audit ?? { longTasks: [], cls: 0 },
  };
};

function normalizeUrl(url) {
  const u = new URL(url);
  return u.pathname
    .replace(/\/\d{9,}(\.\d+)?/g, "/<t>")
    .replace(/[0-9a-f]{8,}/gi, "<id>");
}

// Dates, clock times and epoch timestamps change between runs (timeline
// tick labels, event ids), so leave them out of a finding's fingerprint
function fingerprint(key) {
  return key
    .replace(
      /\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/gi,
      "<time>",
    )
    .replace(/\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/gi, "<time>")
    .replace(/\d{9,}(\.\d+)?/g, "<t>");
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium
    .launch({ channel: "chrome" })
    .catch(() => chromium.launch());
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: BASE,
    ...PROFILES[PROFILE],
  });
  await context.addInitScript(PERF_INIT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  let current = "login";
  const events = [];
  const requests = [];
  const add = (kind, text) =>
    events.push({
      page: current,
      kind,
      text: String(text).replace(/\s+/g, " ").slice(0, 300),
    });
  page.on("pageerror", (e) => add("exception", e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      add(`console.${m.type()}`, m.text());
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    // Network errors also arrive as console errors; keep Chrome's own warnings
    if (
      entry.source !== "network" &&
      entry.source !== "console-api" &&
      ["warning", "error"].includes(entry.level)
    ) {
      add(`chrome.${entry.level}`, entry.text);
    }
  });
  await cdp.send("Log.enable");
  page.on("request", (r) =>
    requests.push({
      page: current,
      at: Date.now(),
      url: normalizeUrl(r.url()),
    }),
  );
  page.on("requestfailed", (r) => {
    const why = r.failure()?.errorText ?? "";
    if (!why.includes("ERR_ABORTED"))
      add("requestfailed", `${r.method()} ${normalizeUrl(r.url())} ${why}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400)
      add(
        "http",
        `${r.status()} ${r.request().method()} ${normalizeUrl(r.url())}`,
      );
  });

  await page.goto("/login");
  await page.fill('input[name="user"]', USER);
  await page.fill('input[name="password"]', PASSWORD);
  await page.getByRole("button", { name: /login/i }).click();
  await page.waitForSelector("#pageRoot", { timeout: 20_000 });

  const config = await page.evaluate(() =>
    fetch("api/config").then((r) => r.json()),
  );
  const cameras = Object.keys(config.cameras ?? {});
  const pages = [
    "/",
    ...cameras.map((c) => `/#${c}`),
    "/review",
    "/explore",
    "/export",
    "/settings",
    ...settingsKeys().map((k) => `/settings?page=${k}`),
    ...["general", "models", "storage", "cameras", "health"].map(
      (t) => `/system#${t}`,
    ),
    "/logs",
    "/config",
    "/faces",
    "/classification",
  ];

  const results = [];
  for (const path of pages) {
    current = path;
    const started = Date.now();
    const result = { path, backFailures: [], storms: [], axe: [] };
    try {
      await page.goto(path);
      await page.waitForSelector("#pageRoot", { timeout: 15_000 });
      await page.waitForTimeout(DWELL_MS);
      result.finalPath =
        new URL(page.url()).pathname + new URL(page.url()).hash;

      // Request storms during the dwell
      const window = requests.filter((r) => r.page === path && r.at >= started);
      const seconds = Math.max(1, (Date.now() - started) / 1000);
      const counts = {};
      for (const r of window) counts[r.url] = (counts[r.url] ?? 0) + 1;
      result.storms = Object.entries(counts)
        .filter(([, n]) => n / seconds > 8)
        .map(([url, n]) => `${url} ${(n / seconds).toFixed(1)}/s`);

      Object.assign(
        result,
        await page.evaluate(LAYOUT_PROBE, PROFILE === "phone"),
      );

      await page.addScriptTag({ content: axeSource });
      result.axe = await page.evaluate(async () => {
        const res = await window.axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
          },
          resultTypes: ["violations"],
        });
        return res.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          count: v.nodes.length,
          help: v.help,
          sample: v.nodes[0]?.target?.join(" ") ?? "",
          html: (v.nodes[0]?.html ?? "").slice(0, 160),
        }));
      });

      await page.screenshot({
        path: join(
          outDir,
          `${results.length.toString().padStart(2, "0")}${path.replace(/[^a-z0-9]+/gi, "_")}.png`,
        ),
      });

      // Back button: each overlay trigger must close on back and stay put
      const triggers = page.locator(
        '#pageRoot [aria-haspopup="dialog"], #pageRoot [aria-haspopup="menu"]',
      );
      const total = Math.min(await triggers.count(), 6);
      for (let i = 0; i < total; i++) {
        const trigger = triggers.nth(i);
        if (!(await trigger.isVisible().catch(() => false))) continue;
        const name = (
          (await trigger.getAttribute("aria-label")) ||
          (await trigger.innerText().catch(() => "")) ||
          `trigger ${i}`
        )
          .trim()
          .slice(0, 40);
        const before = page.url();
        await trigger.click({ timeout: 3_000 }).catch(() => {});
        await page.waitForTimeout(700);
        const overlay = page.locator(
          '[role="dialog"]:visible, [role="menu"]:visible',
        );
        if (!(await overlay.count())) continue;
        await page.goBack();
        await page.waitForTimeout(900);
        const stillOpen = await overlay.count();
        const moved = page.url() !== before;
        if (stillOpen || moved) {
          result.backFailures.push(
            `${name}: ${stillOpen ? "overlay stayed open" : ""}${stillOpen && moved ? ", " : ""}${moved ? `left to ${new URL(page.url()).pathname}` : ""}`,
          );
          await page.goto(path);
          await page.waitForSelector("#pageRoot", { timeout: 15_000 });
          await page.waitForTimeout(1_500);
        }
      }
    } catch (err) {
      result.error = err.message.split("\n")[0];
    }
    result.events = events.filter((e) => e.page === path);
    results.push(result);
    process.stdout.write(`${result.error ? "!" : "."}`);
  }
  process.stdout.write("\n");
  await browser.close();

  // Findings, fingerprinted for the baseline comparison
  const findings = [];
  const push = (page, kind, key, detail = "") => {
    const known = KNOWN.find((k) => k.pattern.test(`${kind} ${key}`));
    findings.push({
      id: `${page}|${kind}|${fingerprint(key)}`,
      page,
      kind,
      key,
      detail,
      known: known?.why,
    });
  };
  for (const r of results) {
    if (r.error) push(r.path, "page-error", r.error);
    for (const e of r.events) push(r.path, e.kind, e.text);
    for (const v of r.axe) {
      if (v.impact === "serious" || v.impact === "critical")
        push(
          r.path,
          `axe.${v.impact}`,
          v.id,
          `${v.count}x ${v.help} | ${v.sample} | ${v.html}`,
        );
    }
    if (r.pageOverflow)
      push(
        r.path,
        "overflow",
        `page scrolls sideways ${r.pageOverflow}px`,
        r.overflowing.join("; "),
      );
    for (const t of r.tinyTargets ?? []) push(r.path, "tap-target<24", t);
    for (const b of r.broken ?? []) push(r.path, "broken-image", b);
    for (const s of r.storms)
      push(r.path, "request-storm", s.replace(/ [\d.]+\/s$/, ""), s);
    for (const f of r.backFailures) push(r.path, "back-button", f);
    if ((r.perf?.cls ?? 0) > 0.1)
      push(r.path, "layout-shift", `CLS ${r.perf.cls.toFixed(2)}`);
    for (const d of r.perf?.longTasks ?? [])
      if (d > 500) push(r.path, "long-task", `>500ms`, `${d}ms`);
  }
  const unique = [...new Map(findings.map((f) => [f.id, f])).values()];

  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8"))
    : null;
  const baseIds = new Set(baseline?.findings?.map((f) => f.id) ?? []);
  const nowIds = new Set(unique.map((f) => f.id));
  const fresh = unique.filter(
    (f) => !f.known && (!baseline || !baseIds.has(f.id)),
  );
  const fixed = baseline
    ? baseline.findings.filter((f) => !f.known && !nowIds.has(f.id))
    : [];

  writeFileSync(
    join(outDir, "results.json"),
    JSON.stringify(
      { base: BASE, profile: PROFILE, stamp, results, findings: unique },
      null,
      2,
    ),
  );
  if (args.has("--update-baseline")) {
    writeFileSync(
      baselinePath,
      JSON.stringify({ stamp, findings: unique }, null, 2),
    );
  }

  const row = (r) => {
    const count = (re) => r.events.filter((e) => re.test(e.kind)).length;
    const axeSerious = r.axe.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    ).length;
    return `| \`${r.path}\` | ${r.error ? "FAIL" : "ok"} | ${count(/exception/)} | ${count(/error|http|requestfailed/)} | ${count(/warning/)} | ${axeSerious} | ${r.pageOverflow ? `${r.pageOverflow}px` : ""} | ${r.tinyCount ?? ""}/${r.smallCount ?? ""} | ${(r.broken ?? []).length || ""} | ${r.storms.length || ""} | ${r.backFailures.length || ""} | ${(r.perf?.cls ?? 0).toFixed(2)} |`;
  };
  const byKind = unique
    .filter((f) => !f.known)
    .reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {});
  const lines = [
    `# Demo audit (${PROFILE}) ${stamp}`,
    "",
    `${results.length} pages, ${unique.filter((f) => !f.known).length} findings (${unique.filter((f) => f.known).length} known upstream/demo noise).`,
    baseline
      ? `Against baseline ${baseline.stamp}: **${fresh.length} new**, ${fixed.length} fixed.`
      : "No baseline yet: run with --update-baseline to save one.",
    "",
    "By kind: " +
      (Object.entries(byKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ") || "none"),
    "",
    "| page | load | exc | err | warn | axe serious | overflow | taps <24/<40 | broken img | storms | back fails | CLS |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...results.map(row),
    "",
    `## ${baseline ? "New findings" : "Findings"}`,
    ...(baseline ? fresh : unique.filter((f) => !f.known)).map(
      (f) =>
        `- **${f.kind}** \`${f.page}\`: ${f.key}${f.detail ? ` (${f.detail})` : ""}`,
    ),
    "",
    ...(fixed.length
      ? [
          "## Fixed since baseline",
          ...fixed.map((f) => `- ${f.kind} \`${f.page}\`: ${f.key}`),
          "",
        ]
      : []),
    "## Known noise",
    ...[
      ...new Set(
        unique.filter((f) => f.known).map((f) => `- ${f.kind}: ${f.known}`),
      ),
    ],
  ];
  writeFileSync(join(outDir, "report.md"), lines.join("\n") + "\n");
  console.log(`report: ${join(outDir, "report.md")}`);
  if (args.has("--strict") && fresh.length) process.exit(1);
}

await main();
