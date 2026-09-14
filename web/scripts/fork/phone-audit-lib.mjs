/**
 * The demo audit (see phone-audit.mjs for what it checks and how to run it).
 * The browser is passed in, so the whole run can be unit-tested against a
 * fake one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROFILES = {
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
export const KNOWN = [
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

const OVERLAY_TRIGGERS =
  '#pageRoot [aria-haspopup="dialog"], #pageRoot [aria-haspopup="menu"]';
const OPEN_OVERLAY = '[role="dialog"]:visible, [role="menu"]:visible';

/** KEY=value lines of a .env file. */
export function parseEnv(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
}

/** Settings page keys listed in command-items.ts's SETTINGS_SECTIONS. */
export function settingsKeysFrom(source) {
  const block = source.slice(source.indexOf("export const SETTINGS_SECTIONS"));
  const end = block.indexOf("];");
  return [...block.slice(0, end).matchAll(/key: "([A-Za-z]+)"/g)].map(
    (m) => m[1],
  );
}

/** Every page the audit visits, in order. */
export function buildPages(cameras, settingsKeys) {
  return [
    "/",
    ...cameras.map((c) => `/#${c}`),
    "/review",
    "/explore",
    "/export",
    "/settings",
    ...settingsKeys.map((k) => `/settings?page=${k}`),
    ...["general", "models", "storage", "cameras", "health"].map(
      (t) => `/system#${t}`,
    ),
    "/logs",
    "/config",
    "/faces",
    "/classification",
  ];
}

// Injected into every document: long tasks and layout shift
export const PERF_INIT = () => {
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
export const LAYOUT_PROBE = (phone) => {
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

// Runs in the page once axe-core is injected: WCAG 2.1 AA violations
export const AXE_RUN = async () => {
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
};

export function normalizeUrl(url) {
  const u = new URL(url);
  return u.pathname
    .replace(/\/\d{9,}(\.\d+)?/g, "/<t>")
    .replace(/[0-9a-f]{8,}/gi, "<id>");
}

// Dates, clock times and epoch timestamps change between runs (timeline
// tick labels, event ids), so leave them out of a finding's fingerprint
export function fingerprint(key) {
  return key
    .replace(
      /\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/gi,
      "<time>",
    )
    .replace(/\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/gi, "<time>")
    .replace(/\d{9,}(\.\d+)?/g, "<t>");
}

/** URL patterns `path` requested more than `limit` times a second since `started`. */
export function detectStorms(requests, path, started, now, limit = 8) {
  const seconds = Math.max(1, (now - started) / 1000);
  const counts = {};
  for (const r of requests) {
    if (r.page === path && r.at >= started) {
      counts[r.url] = (counts[r.url] ?? 0) + 1;
    }
  }
  return Object.entries(counts)
    .filter(([, n]) => n / seconds > limit)
    .map(([url, n]) => `${url} ${(n / seconds).toFixed(1)}/s`);
}

/**
 * Record console errors and warnings, Chrome's own log warnings, exceptions,
 * requests and HTTP errors into `state`, tagged with `state.current`.
 */
export function recordPageActivity(page, cdp, state) {
  const add = (kind, text) =>
    state.events.push({
      page: state.current,
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
  page.on("request", (r) =>
    state.requests.push({
      page: state.current,
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
}

/** How a trigger failed the back-button check. */
export function backFailure(name, stillOpen, movedTo) {
  const parts = [];
  if (stillOpen) parts.push("overlay stayed open");
  if (movedTo) parts.push(`left to ${movedTo}`);
  return `${name}: ${parts.join(", ")}`;
}

/**
 * Open each menu/drawer trigger on `path`, press back, and list the ones
 * whose overlay stayed open or that left the page.
 */
export async function checkBackButtons(
  page,
  path,
  { maxTriggers = 6, openWait = 700, backWait = 900, reloadWait = 1_500 } = {},
) {
  const failures = [];
  const triggers = page.locator(OVERLAY_TRIGGERS);
  const total = Math.min(await triggers.count(), maxTriggers);
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
    await page.waitForTimeout(openWait);
    const overlay = page.locator(OPEN_OVERLAY);
    if (!(await overlay.count())) continue;
    await page.goBack();
    await page.waitForTimeout(backWait);
    const stillOpen = (await overlay.count()) > 0;
    const moved = page.url() !== before;
    if (stillOpen || moved) {
      failures.push(
        backFailure(
          name,
          stillOpen,
          moved ? new URL(page.url()).pathname : null,
        ),
      );
      await page.goto(path);
      await page.waitForSelector("#pageRoot", { timeout: 15_000 });
      await page.waitForTimeout(reloadWait);
    }
  }
  return failures;
}

/** Visit one page and collect everything the audit checks there. */
export async function auditPage(
  page,
  path,
  { state, dwellMs, phone, axeSource, screenshotPath, now = Date.now },
) {
  const started = now();
  const result = { path, backFailures: [], storms: [], axe: [] };
  try {
    await page.goto(path);
    await page.waitForSelector("#pageRoot", { timeout: 15_000 });
    await page.waitForTimeout(dwellMs);
    const url = new URL(page.url());
    result.finalPath = url.pathname + url.hash;
    result.storms = detectStorms(state.requests, path, started, now());
    Object.assign(result, await page.evaluate(LAYOUT_PROBE, phone));
    await page.addScriptTag({ content: axeSource });
    result.axe = await page.evaluate(AXE_RUN);
    await page.screenshot({ path: screenshotPath });
    result.backFailures = await checkBackButtons(page, path);
  } catch (err) {
    result.error = err.message.split("\n")[0];
  }
  result.events = state.events.filter((e) => e.page === path);
  return result;
}

/** Findings from every page, fingerprinted and de-duplicated. */
export function collectFindings(results) {
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
  return [...new Map(findings.map((f) => [f.id, f])).values()];
}

/** New findings (not in the baseline) and fixed ones (gone since it). */
export function compareBaseline(unique, baseline) {
  const baseIds = new Set(baseline?.findings?.map((f) => f.id) ?? []);
  const nowIds = new Set(unique.map((f) => f.id));
  return {
    fresh: unique.filter((f) => !f.known && (!baseline || !baseIds.has(f.id))),
    fixed: baseline
      ? baseline.findings.filter((f) => !f.known && !nowIds.has(f.id))
      : [],
  };
}

/** The Markdown report for one run. */
export function renderReport({
  profile,
  stamp,
  results,
  unique,
  baseline,
  fresh,
  fixed,
}) {
  const row = (r) => {
    const count = (re) => r.events.filter((e) => re.test(e.kind)).length;
    const axeSerious = r.axe.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    ).length;
    return `| \`${r.path}\` | ${r.error ? "FAIL" : "ok"} | ${count(/exception/)} | ${count(/error|http|requestfailed/)} | ${count(/warning/)} | ${axeSerious} | ${r.pageOverflow ? `${r.pageOverflow}px` : ""} | ${r.tinyCount ?? ""}/${r.smallCount ?? ""} | ${(r.broken ?? []).length || ""} | ${r.storms.length || ""} | ${r.backFailures.length || ""} | ${(r.perf?.cls ?? 0).toFixed(2)} |`;
  };
  const real = unique.filter((f) => !f.known);
  const byKind = real.reduce(
    (acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }),
    {},
  );
  const lines = [
    `# Demo audit (${profile}) ${stamp}`,
    "",
    `${results.length} pages, ${real.length} findings (${unique.length - real.length} known upstream/demo noise).`,
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
    ...(baseline ? fresh : real).map(
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
    ...new Set(
      unique.filter((f) => f.known).map((f) => `- ${f.kind}: ${f.known}`),
    ),
  ];
  return lines.join("\n") + "\n";
}

/**
 * Sign in, audit every page and write results.json, report.md and the
 * screenshots to `outDir`, comparing with (and optionally replacing) the
 * baseline. Returns the findings and where the report went.
 */
export async function runAudit({
  chromium,
  base,
  profile,
  dwellMs,
  user,
  password,
  axeSource,
  settingsSource,
  outDir,
  baselinePath,
  stamp,
  updateBaseline = false,
  progress = (mark) => process.stdout.write(mark),
}) {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium
    .launch({ channel: "chrome" })
    .catch(() => chromium.launch());
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: base,
    ...PROFILES[profile],
  });
  await context.addInitScript(PERF_INIT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const state = { current: "login", events: [], requests: [] };
  recordPageActivity(page, cdp, state);
  await cdp.send("Log.enable");

  await page.goto("/login");
  await page.fill('input[name="user"]', user);
  await page.fill('input[name="password"]', password);
  await page.getByRole("button", { name: /login/i }).click();
  await page.waitForSelector("#pageRoot", { timeout: 20_000 });

  const config = await page.evaluate(() =>
    fetch("api/config").then((r) => r.json()),
  );
  const pages = buildPages(
    Object.keys(config.cameras ?? {}),
    settingsKeysFrom(settingsSource),
  );

  const results = [];
  for (const path of pages) {
    state.current = path;
    const result = await auditPage(page, path, {
      state,
      dwellMs,
      phone: profile === "phone",
      axeSource,
      screenshotPath: join(
        outDir,
        `${results.length.toString().padStart(2, "0")}${path.replace(/[^a-z0-9]+/gi, "_")}.png`,
      ),
    });
    results.push(result);
    progress(result.error ? "!" : ".");
  }
  progress("\n");
  await browser.close();

  const unique = collectFindings(results);
  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8"))
    : null;
  const { fresh, fixed } = compareBaseline(unique, baseline);

  writeFileSync(
    join(outDir, "results.json"),
    JSON.stringify(
      { base, profile, stamp, results, findings: unique },
      null,
      2,
    ),
  );
  if (updateBaseline) {
    writeFileSync(
      baselinePath,
      JSON.stringify({ stamp, findings: unique }, null, 2),
    );
  }
  const reportPath = join(outDir, "report.md");
  writeFileSync(
    reportPath,
    renderReport({ profile, stamp, results, unique, baseline, fresh, fixed }),
  );
  return { results, unique, fresh, fixed, reportPath };
}
