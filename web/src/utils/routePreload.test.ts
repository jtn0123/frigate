import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const loaded = vi.hoisted(() => vi.fn());
vi.mock("@/pages/System", () => {
  loaded();
  return { default: () => null };
});

beforeEach(() => {
  vi.resetModules();
  loaded.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("intent-based page preloading", () => {
  it.each([
    { onLine: false },
    { onLine: true, connection: { saveData: true } },
    { onLine: true, connection: { effectiveType: "2g" } },
    { onLine: true, connection: { effectiveType: "3g" } },
  ])(
    "does not download on a constrained connection: %j",
    async (connection) => {
      vi.stubGlobal("navigator", connection);
      const { preloadRoute } = await import("./routePreload");
      preloadRoute("/system#models");
      await Promise.resolve();
      expect(loaded).not.toHaveBeenCalled();
    },
  );
  it("loads a supported page once and ignores unrelated destinations", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { preloadRoute } = await import("./routePreload");
    preloadRoute("https://example.org/system");
    preloadRoute("/system?model=audio#models");
    preloadRoute("/system#health");
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
  });
});
