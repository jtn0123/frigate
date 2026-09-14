import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AXE_RUN,
  KNOWN,
  LAYOUT_PROBE,
  PERF_INIT,
  auditPage,
  backFailure,
  buildPages,
  checkBackButtons,
  collectFindings,
  compareBaseline,
  detectStorms,
  fingerprint,
  normalizeUrl,
  parseEnv,
  recordPageActivity,
  renderReport,
  runAudit,
  settingsKeysFrom,
} from "./phone-audit-lib.mjs";

afterEach(() => {
  document.body.innerHTML = "";
  delete window.__audit;
  delete window.axe;
  vi.unstubAllGlobals();
});

describe("inputs", () => {
  it("reads KEY=value lines and keeps = inside values", () => {
    expect(
      parseEnv("# comment\nFRIGATE_DEMO_PASSWORD=a=b\nlower=x\n\nUSER=me"),
    ).toEqual({ FRIGATE_DEMO_PASSWORD: "a=b", USER: "me" });
  });

  it("takes settings keys only from SETTINGS_SECTIONS", () => {
    const source = `const OTHER = [{ key: "nope" }];
export const SETTINGS_SECTIONS = [
  { key: "uiSettings", label: "UI" },
  { key: "cameraDetect", label: "Detect" },
];
const LATER = [{ key: "alsoNope" }];`;
    expect(settingsKeysFrom(source)).toEqual(["uiSettings", "cameraDetect"]);
  });

  it("visits Live, each camera, the pages and every settings section", () => {
    const pages = buildPages(["street", "lot"], ["uiSettings"]);
    expect(pages.slice(0, 4)).toEqual(["/", "/#street", "/#lot", "/review"]);
    expect(pages).toContain("/settings?page=uiSettings");
    expect(pages).toContain("/system#health");
    expect(pages.at(-1)).toBe("/classification");
  });
});

describe("fingerprints", () => {
  it("folds timestamps and ids out of request paths", () => {
    expect(
      normalizeUrl(
        "https://x/api/events/1789391370.724506-6vswbv/thumbnail.webp?h=1",
      ),
    ).toBe("/api/events/<t>-6vswbv/thumbnail.webp");
    expect(normalizeUrl("https://x/api/review/deadbeefcafe/audio")).toBe(
      "/api/review/<id>/audio",
    );
  });

  it("drops dates, clock times and epochs from finding keys", () => {
    expect(fingerprint("tick 9/13/2026, 9:28:28 PM at 1789391370.5")).toBe(
      "tick <time> at <t>",
    );
    expect(fingerprint("label 10:15 PM")).toBe("label <time>");
  });
});

describe("detectStorms", () => {
  it("reports URLs requested more than 8 times a second on this page", () => {
    const requests = [
      ...Array.from({ length: 40 }, (_, i) => ({
        page: "/a",
        at: 1_000 + i * 50,
        url: "/api/lot/latest.webp",
      })),
      { page: "/a", at: 1_500, url: "/api/stats" },
      { page: "/b", at: 1_500, url: "/api/lot/latest.webp" },
      { page: "/a", at: 500, url: "/api/stats" },
    ];
    expect(detectStorms(requests, "/a", 1_000, 3_000)).toEqual([
      "/api/lot/latest.webp 20.0/s",
    ]);
  });

  it("counts a short visit as at least a second", () => {
    const requests = Array.from({ length: 9 }, () => ({
      page: "/a",
      at: 10,
      url: "/x",
    }));
    expect(detectStorms(requests, "/a", 0, 100)).toEqual(["/x 9.0/s"]);
  });
});

function emitter() {
  const handlers = {};
  return {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    emit: (event, payload) => handlers[event](payload),
  };
}

describe("recordPageActivity", () => {
  it("records console, Chrome log, exceptions, requests and HTTP errors", () => {
    const page = emitter();
    const cdp = emitter();
    const state = { current: "/", events: [], requests: [] };
    recordPageActivity(page, cdp, state);

    page.emit("pageerror", { message: "boom\n  at x" });
    page.emit("console", { type: () => "warning", text: () => "careful" });
    page.emit("console", { type: () => "log", text: () => "ignored" });
    cdp.emit("Log.entryAdded", {
      entry: { source: "other", level: "warning", text: "broken close frame" },
    });
    cdp.emit("Log.entryAdded", {
      entry: { source: "network", level: "error", text: "dup of http" },
    });
    page.emit("request", { url: () => "https://x/api/1789391370/a" });
    page.emit("requestfailed", {
      failure: () => ({ errorText: "net::ERR_ABORTED" }),
      method: () => "GET",
      url: () => "https://x/aborted",
    });
    page.emit("requestfailed", {
      failure: () => null,
      method: () => "GET",
      url: () => "https://x/failed",
    });
    page.emit("response", {
      status: () => 404,
      request: () => ({ method: () => "GET" }),
      url: () => "https://x/missing",
    });
    page.emit("response", {
      status: () => 200,
      request: () => ({ method: () => "GET" }),
      url: () => "https://x/fine",
    });

    expect(state.events.map((e) => `${e.kind} ${e.text}`)).toEqual([
      "exception boom at x",
      "console.warning careful",
      "chrome.warning broken close frame",
      "requestfailed GET /failed ",
      "http 404 GET /missing",
    ]);
    expect(state.requests).toEqual([
      { page: "/", at: expect.any(Number), url: "/api/<t>/a" },
    ]);
  });
});

// A page with overlay triggers; each trigger says what opening it and then
// pressing back does
function fakePage(triggers, { url = "https://x/review" } = {}) {
  let current = url;
  let open = null;
  const visits = [];
  const page = {
    visits,
    url: () => current,
    goto: async (path) => {
      visits.push(path);
      current = new URL(path, "https://x").href;
      open = null;
    },
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    goBack: async () => {
      if (open?.onBack === "close") open = null;
      if (open?.onBack === "leave") {
        current = "https://x/elsewhere";
        open = null;
      }
    },
    locator: (selector) => {
      if (selector.includes("aria-haspopup")) {
        return {
          count: async () => triggers.length,
          nth: (i) => ({
            isVisible: async () => triggers[i].visible !== false,
            getAttribute: async () => triggers[i].label ?? null,
            innerText: async () => triggers[i].text ?? "",
            click: async () => {
              if (triggers[i].opens !== false) open = triggers[i];
            },
          }),
        };
      }
      return { count: async () => (open ? 1 : 0) };
    },
  };
  return page;
}

describe("checkBackButtons", () => {
  const fast = { openWait: 0, backWait: 0, reloadWait: 0 };

  it("passes overlays that close on back and stay on the page", async () => {
    const page = fakePage([
      { label: "Filters", onBack: "close" },
      { label: "Hidden", visible: false, onBack: "stay" },
      { label: "Not an overlay", opens: false },
    ]);
    expect(await checkBackButtons(page, "/review", fast)).toEqual([]);
    expect(page.visits).toEqual([]);
  });

  it("reports overlays that stay open or leave, and reloads the page", async () => {
    const page = fakePage([
      { label: "Settings", onBack: "stay" },
      { text: "  Menu  ", onBack: "leave" },
      { onBack: "stay" },
    ]);
    expect(await checkBackButtons(page, "/review", fast)).toEqual([
      "Settings: overlay stayed open",
      "Menu: left to /elsewhere",
      // the page is reloaded after a failure, so this one starts on /review
      "trigger 2: overlay stayed open",
    ]);
    expect(page.visits).toEqual(["/review", "/review", "/review"]);
  });

  it("checks at most six triggers", async () => {
    const page = fakePage(
      Array.from({ length: 9 }, (_, i) => ({ label: `t${i}`, onBack: "stay" })),
    );
    expect(await checkBackButtons(page, "/", fast)).toHaveLength(6);
  });

  it("describes both failures at once", () => {
    expect(backFailure("Menu", true, "/x")).toBe(
      "Menu: overlay stayed open, left to /x",
    );
  });
});

describe("auditPage", () => {
  it("collects layout, axe, storms, events and back failures", async () => {
    const page = fakePage([]);
    const probe = { pageOverflow: 0, tinyTargets: [], perf: { cls: 0 } };
    page.evaluate = async (fn) =>
      fn === LAYOUT_PROBE ? probe : [{ id: "button-name", impact: "critical" }];
    page.addScriptTag = vi.fn(async () => {});
    page.screenshot = vi.fn(async () => {});
    const state = {
      events: [
        { page: "/review", kind: "http", text: "404" },
        { page: "/other", kind: "http", text: "500" },
      ],
      requests: Array.from({ length: 20 }, () => ({
        page: "/review",
        // after the visit starts (clock 1000) and before it ends (2000)
        at: 1_500,
        url: "/api/x",
      })),
    };
    let clock = 0;

    const result = await auditPage(page, "/review", {
      state,
      dwellMs: 0,
      phone: true,
      axeSource: "axe()",
      screenshotPath: "/tmp/shot.png",
      now: () => (clock += 1000),
    });

    expect(result).toMatchObject({
      path: "/review",
      finalPath: "/review",
      storms: ["/api/x 20.0/s"],
      axe: [{ id: "button-name", impact: "critical" }],
      backFailures: [],
      events: [{ page: "/review", kind: "http", text: "404" }],
      ...probe,
    });
    expect(page.addScriptTag).toHaveBeenCalledWith({ content: "axe()" });
    expect(page.screenshot).toHaveBeenCalledWith({ path: "/tmp/shot.png" });
  });

  it("keeps the first line of a load error", async () => {
    const page = fakePage([]);
    page.goto = async () => {
      throw new Error("Timeout 15000ms exceeded\n  call log");
    };
    const result = await auditPage(page, "/logs", {
      state: { events: [], requests: [] },
      dwellMs: 0,
    });
    expect(result.error).toBe("Timeout 15000ms exceeded");
    expect(result.events).toEqual([]);
  });
});

describe("findings", () => {
  const results = [
    {
      path: "/",
      error: "Timeout",
      events: [
        { kind: "http", text: "404 GET /api/preview/abc" },
        { kind: "console.error", text: "tick 9:28 PM" },
        { kind: "console.error", text: "tick 9:29 PM" },
      ],
      axe: [
        { id: "button-name", impact: "critical", count: 1, help: "h" },
        { id: "region", impact: "moderate", count: 2, help: "h" },
      ],
      pageOverflow: 12,
      overflowing: ["Grid (right 430px)"],
      tinyTargets: ["Info 20x20"],
      broken: ["/img.png"],
      storms: ["/api/x 20.0/s"],
      backFailures: ["Menu: overlay stayed open"],
      perf: { cls: 0.25, longTasks: [300, 700] },
    },
    { path: "/logs", events: [], axe: [], storms: [], backFailures: [] },
  ];

  it("fingerprints, flags known noise and drops duplicates", () => {
    const unique = collectFindings(results);
    const kinds = unique.map((f) => f.kind);
    expect(kinds).toEqual([
      "page-error",
      "http",
      "console.error",
      "axe.critical",
      "overflow",
      "tap-target<24",
      "broken-image",
      "request-storm",
      "back-button",
      "layout-shift",
      "long-task",
    ]);
    expect(unique.find((f) => f.kind === "http").known).toBe(KNOWN[0].why);
    expect(unique.find((f) => f.kind === "request-storm").key).toBe("/api/x");
    expect(unique.find((f) => f.kind === "long-task").detail).toBe("700ms");
  });

  it("splits new and fixed findings against a baseline", () => {
    const unique = collectFindings(results);
    expect(compareBaseline(unique, null).fixed).toEqual([]);
    expect(compareBaseline(unique, null).fresh).toHaveLength(10);

    const baseline = {
      stamp: "old",
      findings: [
        unique[0],
        { id: "/|gone|x", kind: "gone", page: "/", key: "x" },
        { id: "/|noise|y", kind: "noise", page: "/", key: "y", known: "n" },
      ],
    };
    const { fresh, fixed } = compareBaseline(unique, baseline);
    expect(fresh).toHaveLength(9);
    expect(fixed.map((f) => f.id)).toEqual(["/|gone|x"]);
  });

  it("renders the report with and without a baseline", () => {
    const unique = collectFindings(results);
    const first = renderReport({
      profile: "phone",
      stamp: "s1",
      results,
      unique,
      baseline: null,
      ...compareBaseline(unique, null),
    });
    expect(first).toContain("# Demo audit (phone) s1");
    expect(first).toContain(
      "2 pages, 10 findings (1 known upstream/demo noise)",
    );
    expect(first).toContain("No baseline yet");
    expect(first).toContain("| `/` | FAIL | 0 | 3 | 0 | 1 | 12px |");
    expect(first).toContain("| `/logs` | ok |");
    expect(first).toContain("- http: no preview files yet on a fresh demo");

    const baseline = {
      stamp: "s0",
      findings: [{ id: "/|gone|x", kind: "gone", page: "/", key: "x" }],
    };
    const second = renderReport({
      profile: "phone",
      stamp: "s2",
      results,
      unique,
      baseline,
      ...compareBaseline(unique, baseline),
    });
    expect(second).toContain("Against baseline s0: **10 new**, 1 fixed.");
    expect(second).toContain("## Fixed since baseline");
    expect(second).toContain("- gone `/`: x");
  });
});

describe("in-page probes", () => {
  function box(el, rect) {
    el.getBoundingClientRect = () => ({
      top: 10,
      bottom: 10 + rect.height,
      left: 0,
      right: rect.right ?? rect.width,
      width: rect.width,
      height: rect.height,
    });
    return el;
  }

  it("finds overflow, small and tiny targets and broken images", () => {
    Object.defineProperty(document, "scrollingElement", {
      configurable: true,
      value: { scrollWidth: window.innerWidth + 30 },
    });
    const add = (html, rect) => {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      const el = holder.firstElementChild;
      document.body.append(el);
      return box(el, rect);
    };
    add('<button aria-label="Info"></button>', { width: 20, height: 20 });
    add('<button aria-label="Zoom"></button>', { width: 32, height: 32 });
    add('<button aria-label="Big"></button>', { width: 48, height: 48 });
    add('<div aria-hidden="true"><button aria-label="Ghost"></button></div>', {
      width: 10,
      height: 10,
    });
    add('<div title="Wide strip"></div>', {
      width: 50,
      height: 50,
      right: window.innerWidth + 100,
    });
    const img = add('<img src="/api/lot/latest.webp">', {
      width: 100,
      height: 60,
    });
    Object.defineProperty(img, "complete", { value: true });
    Object.defineProperty(img, "naturalWidth", { value: 0 });

    const phone = LAYOUT_PROBE(true);
    expect(phone.pageOverflow).toBe(30);
    expect(phone.overflowing).toEqual([
      `Wide strip (right ${window.innerWidth + 100}px)`,
    ]);
    expect(phone.tinyTargets).toEqual(["Info 20x20"]);
    expect(phone.smallTargets).toEqual(["Zoom 32x32"]);
    expect(phone.broken).toEqual(["/api/lot/latest.webp"]);
    expect(phone.perf).toEqual({ longTasks: [], cls: 0 });

    expect(LAYOUT_PROBE(false).smallCount).toBe(0);
  });

  it("collects long tasks and layout shift from the observers", () => {
    const observers = [];
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        constructor(callback) {
          this.callback = callback;
          observers.push(this);
        }
        observe(options) {
          this.type = options.type;
        }
      },
    );
    PERF_INIT();
    const [tasks, shifts] = observers;
    tasks.callback({
      getEntries: () => [{ duration: 150 }, { duration: 260.4 }],
    });
    shifts.callback({
      getEntries: () => [
        { hadRecentInput: false, value: 0.2 },
        { hadRecentInput: true, value: 0.5 },
      ],
    });
    expect(window.__audit).toEqual({ longTasks: [260], cls: 0.2 });
  });

  it("keeps the defaults where the observers are unsupported", () => {
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        observe() {
          throw new TypeError("unsupported entry type");
        }
      },
    );
    PERF_INIT();
    expect(window.__audit).toEqual({ longTasks: [], cls: 0 });
  });

  it("maps axe violations to the fields the report uses", async () => {
    window.axe = {
      run: vi.fn(async () => ({
        violations: [
          {
            id: "button-name",
            impact: "critical",
            help: "Buttons must have discernible text",
            nodes: [{ target: ["#a", "button"], html: "<button></button>" }],
          },
          { id: "empty", impact: "minor", help: "h", nodes: [] },
        ],
      })),
    };
    expect(await AXE_RUN()).toEqual([
      {
        id: "button-name",
        impact: "critical",
        count: 1,
        help: "Buttons must have discernible text",
        sample: "#a button",
        html: "<button></button>",
      },
      {
        id: "empty",
        impact: "minor",
        count: 0,
        help: "h",
        sample: "",
        html: "",
      },
    ]);
  });
});

describe("runAudit", () => {
  // A browser whose one page has a camera, no overlay triggers and no issues
  function fakeBrowser({ chromeInstalled = true } = {}) {
    const page = fakePage([]);
    const calls = { fills: [], clicked: false, closed: false, launches: [] };
    Object.assign(page, {
      on: () => {},
      fill: async (selector, value) => calls.fills.push([selector, value]),
      getByRole: () => ({
        click: async () => {
          calls.clicked = true;
        },
      }),
      evaluate: async (fn) => {
        if (fn === LAYOUT_PROBE) return { pageOverflow: 0, perf: { cls: 0 } };
        if (fn === AXE_RUN) return [];
        return { cameras: { street: {} } };
      },
      addScriptTag: async () => {},
      screenshot: async () => {},
    });
    const context = {
      addInitScript: async () => {},
      newPage: async () => page,
      newCDPSession: async () => ({ on: () => {}, send: async () => {} }),
    };
    const browser = {
      newContext: async () => context,
      close: async () => {
        calls.closed = true;
      },
    };
    const chromium = {
      launch: async (options) => {
        calls.launches.push(options ?? null);
        if (options?.channel === "chrome" && !chromeInstalled)
          throw new Error("chrome not installed");
        return browser;
      },
    };
    return { chromium, calls, page };
  }

  async function run(chromium, dir, extra = {}) {
    return runAudit({
      chromium,
      base: "https://demo",
      profile: "phone",
      dwellMs: 0,
      user: "admin",
      password: "secret",
      axeSource: "",
      settingsSource:
        'export const SETTINGS_SECTIONS = [{ key: "uiSettings" }];',
      outDir: join(dir, "run"),
      baselinePath: join(dir, "baseline.json"),
      stamp: "s1",
      progress: () => {},
      ...extra,
    });
  }

  it("signs in, audits every page and writes the report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phone-audit-"));
    const { chromium, calls, page } = fakeBrowser({ chromeInstalled: false });

    const { results, fresh, reportPath } = await run(chromium, dir, {
      updateBaseline: true,
    });

    expect(calls.launches).toEqual([{ channel: "chrome" }, null]);
    expect(calls.fills).toEqual([
      ['input[name="user"]', "admin"],
      ['input[name="password"]', "secret"],
    ]);
    expect(calls.clicked).toBe(true);
    expect(calls.closed).toBe(true);
    expect(results.map((r) => r.path)).toEqual(
      buildPages(["street"], ["uiSettings"]),
    );
    expect(page.visits[0]).toBe("/login");
    expect(fresh).toEqual([]);
    expect(readFileSync(reportPath, "utf8")).toContain(
      "No baseline yet: run with --update-baseline",
    );
    const saved = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8"));
    expect(saved).toEqual({ stamp: "s1", findings: [] });
    const written = JSON.parse(
      readFileSync(join(dir, "run/results.json"), "utf8"),
    );
    expect(written).toMatchObject({ base: "https://demo", profile: "phone" });
  });

  it("compares with an existing baseline and leaves it alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phone-audit-"));
    const baseline = {
      stamp: "s0",
      findings: [{ id: "/|http|gone", kind: "http", page: "/", key: "gone" }],
    };
    writeFileSync(join(dir, "baseline.json"), JSON.stringify(baseline));

    const { fixed, reportPath } = await run(fakeBrowser().chromium, dir);

    expect(fixed.map((f) => f.id)).toEqual(["/|http|gone"]);
    expect(readFileSync(reportPath, "utf8")).toContain(
      "Against baseline s0: **0 new**, 1 fixed.",
    );
    expect(
      JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8")),
    ).toEqual(baseline);
  });
});
