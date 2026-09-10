import { afterEach, describe, expect, it, vi } from "vitest";

// forkFlags is computed at import time, so every case reloads the module.
async function load() {
  vi.resetModules();
  return import("./flags");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fork flags", () => {
  it("defaults every flag on when nothing is stored", async () => {
    const { forkFlags, isForkEnabled } = await load();
    expect(Object.keys(forkFlags).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(forkFlags)) {
      expect(value, key).toBe(true);
      expect(isForkEnabled(key as keyof typeof forkFlags)).toBe(true);
    }
  });

  it("applies a localStorage override for a single flag", async () => {
    localStorage.setItem(
      "frigateFork",
      JSON.stringify({ commandPalette: false }),
    );
    const { forkFlags, isForkEnabled } = await load();
    expect(forkFlags.commandPalette).toBe(false);
    expect(isForkEnabled("commandPalette")).toBe(false);
    expect(isForkEnabled("errorBoundary")).toBe(true);
  });

  it("applies several overrides at once", async () => {
    localStorage.setItem(
      "frigateFork",
      JSON.stringify({ themeControls: false, bulkActions: false }),
    );
    const { forkFlags } = await load();
    expect(forkFlags.themeControls).toBe(false);
    expect(forkFlags.bulkActions).toBe(false);
    expect(forkFlags.clipSharing).toBe(true);
  });

  it("ignores malformed JSON", async () => {
    localStorage.setItem("frigateFork", "{not json");
    const { forkFlags } = await load();
    expect(forkFlags.commandPalette).toBe(true);
  });

  it("ignores an empty string and a JSON null", async () => {
    localStorage.setItem("frigateFork", "");
    expect((await load()).forkFlags.commandPalette).toBe(true);
    localStorage.setItem("frigateFork", "null");
    expect((await load()).forkFlags.commandPalette).toBe(true);
  });

  it("falls back to defaults when localStorage is unavailable", async () => {
    vi.stubGlobal("localStorage", undefined);
    const { forkFlags } = await load();
    expect(forkFlags.viewportLayout).toBe(true);
  });

  it("falls back to defaults when localStorage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    const { forkFlags } = await load();
    expect(forkFlags.viewportLayout).toBe(true);
  });

  it("exposes a frozen object", async () => {
    const { forkFlags } = await load();
    expect(Object.isFrozen(forkFlags)).toBe(true);
  });
});
