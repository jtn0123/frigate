import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  list: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawn,
  default: { spawnSync: mocks.spawn },
}));
vi.mock("node:fs", () => ({
  default: {
    readFileSync: mocks.read,
    writeFileSync: mocks.write,
    readdirSync: mocks.list,
    statSync: mocks.stat,
  },
  readFileSync: mocks.read,
  writeFileSync: mocks.write,
  readdirSync: mocks.list,
  statSync: mocks.stat,
}));
const originalArgv = process.argv;
const originalBase = process.env.TYPE_RATCHET_BASE;
const rule = "@typescript-eslint/no-floating-promises";
let baseline;
let source;
let output;
let errors;

async function run(...args) {
  process.argv = [
    process.execPath,
    resolve("scripts/fork/type-ratchet.mjs"),
    ...args,
  ];
  return import("./type-ratchet.mjs");
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  delete process.env.TYPE_RATCHET_BASE;
  baseline = { hatches: { explicitAny: 0 }, rules: { [rule]: 0 } };
  source = "const value: string = 'ok';";
  mocks.list.mockImplementation((path) =>
    path.endsWith("nested")
      ? ["camera.tsx"]
      : ["nested", "node_modules", "dist", "coverage", "types.d.ts", "note.md"],
  );
  mocks.stat.mockImplementation((path) => ({
    isDirectory: () => path.endsWith("nested"),
  }));
  mocks.read.mockImplementation((path) =>
    path.endsWith("type-ratchet.json") ? JSON.stringify(baseline) : source,
  );
  mocks.spawn.mockReturnValue({ status: 0, stdout: "[]", stderr: "" });
  output = vi.spyOn(console, "log").mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
});
afterEach(() => {
  process.argv = originalArgv;
  if (originalBase === undefined) {
    delete process.env.TYPE_RATCHET_BASE;
  } else {
    process.env.TYPE_RATCHET_BASE = originalBase;
  }
  vi.restoreAllMocks();
});

// ESLint finds nothing; `git show` answers with `git` for the base baseline.
function withBase(git) {
  mocks.spawn.mockImplementation((command) =>
    command === "git" ? git : { status: 0, stdout: "[]", stderr: "" },
  );
}
function gitShows() {
  return mocks.spawn.mock.calls
    .filter(([command]) => command === "git")
    .map(([, args]) => args);
}

describe("type ratchet against the base branch", () => {
  it("rejects a baseline raised above the base branch's", async () => {
    source = "const value: any = {};";
    baseline.hatches.explicitAny = 1;
    withBase({
      status: 0,
      stdout: JSON.stringify({
        hatches: { explicitAny: 0 },
        rules: { [rule]: 0 },
      }),
    });
    await expect(run()).rejects.toThrow("exit:1");
    expect(gitShows()).toEqual([
      ["show", "origin/next:fork/type-ratchet.json"],
    ]);
    expect(errors).toHaveBeenCalledWith("  hatches.explicitAny: 0 -> 1");
  });
  it("accepts a baseline at or below the base given in TYPE_RATCHET_BASE", async () => {
    process.env.TYPE_RATCHET_BASE = "abc123";
    withBase({
      status: 0,
      stdout: JSON.stringify({
        // A rule the base does not track yet has nothing to compare with.
        hatches: { explicitAny: 2 },
        rules: {},
      }),
    });
    await run();
    expect(process.exit).not.toHaveBeenCalled();
    expect(gitShows()).toEqual([["show", "abc123:fork/type-ratchet.json"]]);
  });
  it.each([
    [
      { status: 128, stdout: "", stderr: "bad revision" },
      "no fork/type-ratchet.json",
    ],
    [{ error: new Error("spawn git ENOENT") }, "no fork/type-ratchet.json"],
    [{ status: 0, stdout: "not JSON" }, "is not JSON"],
  ])(
    "skips the comparison when the base has no usable baseline",
    async (git, why) => {
      baseline.hatches.explicitAny = 5;
      withBase(git);
      await run();
      expect(process.exit).not.toHaveBeenCalled();
      expect(output).toHaveBeenCalledWith(expect.stringContaining(why));
    },
  );
  it("skips the comparison when TYPE_RATCHET_BASE is empty", async () => {
    process.env.TYPE_RATCHET_BASE = "";
    withBase({ status: 0, stdout: "{}" });
    await run();
    expect(gitShows()).toEqual([]);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("TYPE_RATCHET_BASE is empty"),
    );
  });
});

describe("type ratchet command", () => {
  it("accepts an unchanged baseline and skips generated and non-TS files", async () => {
    await run();
    expect(process.exit).not.toHaveBeenCalled();
    expect(
      mocks.read.mock.calls.filter(([path]) => path.endsWith(".tsx")),
    ).toHaveLength(1);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("rejects new escape hatches and tracked lint findings", async () => {
    source = "const value: any = {};";
    mocks.spawn.mockReturnValue({
      status: 1,
      stdout: JSON.stringify([
        { messages: [{ ruleId: rule }, { ruleId: "untracked-rule" }, {}] },
        {},
      ]),
      stderr: "",
    });
    await expect(run()).rejects.toThrow("exit:1");
    expect(errors).toHaveBeenCalledWith("  hatches.explicitAny: 0 -> 1");
    expect(errors).toHaveBeenCalledWith(`  rules.${rule}: 0 -> 1`);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("reports improvements without silently rewriting the baseline", async () => {
    baseline.hatches.explicitAny = 2;
    baseline.rules[rule] = 1;
    await run();
    expect(output).toHaveBeenCalledWith("  hatches.explicitAny: 2 -> 0");
    expect(output).toHaveBeenCalledWith(`  rules.${rule}: 1 -> 0`);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("writes measured counts only when explicitly requested", async () => {
    source = "const value: any = {}; // @ts-expect-error";
    await expect(run("--write")).rejects.toThrow("exit:0");
    expect(mocks.write).toHaveBeenCalledTimes(1);
    const [path, contents] = mocks.write.mock.calls[0];
    expect(path).toMatch(/fork\/type-ratchet.json$/);
    expect(JSON.parse(contents).hatches).toEqual({
      explicitAny: 1,
      tsExpectError: 1,
      asUnknownAs: 0,
      noExplicitAnyDisable: 0,
    });
    expect(JSON.parse(contents).rules[rule]).toBe(0);
  });
  it("fails when the baseline is missing", async () => {
    mocks.read.mockImplementation((path) => {
      if (path.endsWith("type-ratchet.json")) throw new Error("ENOENT");
      return source;
    });
    await expect(run()).rejects.toThrow("exit:2");
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("Run with --write"),
    );
  });
  it("rejects a corrupt baseline without overwriting it", async () => {
    mocks.read.mockImplementation((path) =>
      path.endsWith("type-ratchet.json") ? "not JSON" : source,
    );
    await expect(run()).rejects.toThrow("exit:2");
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("propagates an ESLint launch failure", async () => {
    mocks.spawn.mockReturnValue({ error: new Error("cannot start eslint") });
    await expect(run()).rejects.toThrow("cannot start eslint");
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])(
    "fails closed for empty ESLint output with status %i",
    async (status) => {
      mocks.spawn.mockReturnValue({
        status,
        stdout: "  ",
        stderr: "eslint failed",
      });
      await expect(run()).rejects.toThrow(`exit:${status || 2}`);
      expect(errors).toHaveBeenCalledWith("eslint failed");
    },
  );
  it.each(["", "eslint diagnostic"])(
    "rejects malformed ESLint JSON (%s)",
    async (stderr) => {
      mocks.spawn.mockReturnValue({ status: 1, stdout: "not json", stderr });
      await expect(run()).rejects.toThrow("exit:2");
      expect(errors).toHaveBeenCalledWith("eslint ratchet output was not JSON");
      expect(errors).toHaveBeenCalledWith(stderr || "not json");
    },
  );
});
