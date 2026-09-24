import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("node:fs", () => ({
  readFileSync: mocks.read,
  default: { readFileSync: mocks.read },
}));

let html;
let budget;
let assets;
let output;
let errors;

async function run() {
  await import("./bundle-budget.mjs");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  html = "";
  budget = { eagerGzipBytes: 1_000_000, note: "test budget" };
  assets = new Map();
  mocks.read.mockImplementation((path) => {
    if (path.endsWith("/dist/index.html")) return html;
    if (path.endsWith("/fork/bundle-budget.json"))
      return JSON.stringify(budget);
    const asset = assets.get(path.split("/dist/")[1]);
    if (asset === undefined) throw new Error(`missing ${path}`);
    return Buffer.from(asset);
  });
  output = vi.spyOn(console, "log").mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bundle budget", () => {
  it("counts unique eager JS and CSS from either link attribute order", async () => {
    html = `
      <script src="/BASE_PATH/assets/app.js?v=1"></script>
      <script src="/BASE_PATH/assets/app.js?v=1"></script>
      <link rel="modulepreload" href="/assets/vendor.js">
      <link href="/assets/style.css" rel="stylesheet">
      <link rel="stylesheet" href="/assets/style.css">
      <link rel="icon" href="/assets/icon.svg">
      <script src="/assets/ignored.json"></script>
    `;
    assets.set("assets/app.js", "const app = true;");
    assets.set("assets/vendor.js", "const vendor = true;");
    assets.set("assets/style.css", "body { color: black; }");
    await run();

    const expected = [...assets.values()].reduce(
      (sum, value) => sum + gzipSync(Buffer.from(value), { level: 9 }).length,
      0,
    );
    expect(output.mock.calls[0][0]).toContain("asset");
    expect(
      output.mock.calls
        .slice(1, 4)
        .map(([line]) => line.trim().split(/\s+/)[0]),
    ).toEqual(["style.css", "vendor.js", "app.js?v=1"]);
    expect(output.mock.calls.at(-1)?.[0]).toContain(
      `${expected} / 1000000 (test budget)`,
    );
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([0, -1, "not-a-number"])(
    "rejects a nonpositive or nonnumeric limit (%s)",
    async (value) => {
      budget.eagerGzipBytes = value;
      await expect(run()).rejects.toThrow("exit:2");
      expect(errors).toHaveBeenCalledWith(
        "fork/bundle-budget.json must set eagerGzipBytes > 0",
      );
    },
  );

  it("identifies a missing eager asset and exits with a configuration error", async () => {
    html = '<script src="/assets/missing.js"></script>';
    await expect(run()).rejects.toThrow("exit:2");
    expect(errors.mock.calls[0]?.[0]).toMatch(
      /^missing eager asset: \/assets\/missing\.js \(/,
    );
  });

  it("fails when the eager total exceeds the budget and prints the total", async () => {
    html = '<link rel="stylesheet" href="/assets/style.css">';
    assets.set("assets/style.css", "body { color: black; }");
    budget.eagerGzipBytes = 1;
    await expect(run()).rejects.toThrow("exit:1");
    expect(output.mock.calls.at(-1)?.[0]).toContain(" / 1 (test budget)");
    expect(errors.mock.calls.at(-1)?.[0]).toMatch(
      /eager gzip \d+ exceeds budget 1/,
    );
  });
});
