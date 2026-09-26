import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewportClass } from "@/hooks/fork/use-viewport";

const store = new Map<string, unknown>();
const viewport = vi.hoisted(() => ({ current: "desktop" as ViewportClass }));

vi.mock("idb-keyval", () => ({
  get: vi.fn((key: string) => Promise.resolve(store.get(key))),
  set: vi.fn((key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  }),
}));

vi.mock("@/hooks/fork/use-viewport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/fork/use-viewport")>()),
  getViewportClass: () => viewport.current,
}));

import {
  applyImportPayload,
  buildExportPayload,
  parseUiSettingsFile,
  summarizeImport,
  UI_SETTINGS_FILE_TYPE,
  UiSettingsFile,
} from "@/utils/uiSettingsTransfer";
import { getUserNamespacedKey } from "@/hooks/use-user-persistence";
import {
  deviceLayoutKeyForGroup,
  layoutKeyForGroup,
} from "@/lib/fork/live-layout";

const USER = "alice";
const LAYOUTS_ONLY = { layouts: true, streaming: false, preferences: false };

const small = [{ i: "front", x: 0, y: 0, w: 4, h: 4 }];
const medium = [{ i: "front", x: 0, y: 0, w: 8, h: 6 }];
const large = [{ i: "front", x: 0, y: 0, w: 12, h: 8 }];
const legacy = [{ i: "front", x: 1, y: 1, w: 2, h: 2 }];

function layoutKey(group: string) {
  return getUserNamespacedKey(layoutKeyForGroup(group), USER);
}

function deviceKey(group: string, size: ViewportClass) {
  return getUserNamespacedKey(deviceLayoutKeyForGroup(group, size), USER);
}

function makeFile(
  sections: Partial<UiSettingsFile["sections"]> = {},
): UiSettingsFile {
  return {
    type: UI_SETTINGS_FILE_TYPE,
    version: 1,
    exported_at: "2026-01-01T00:00:00.000Z",
    frigate_version: "0.18.0",
    sections: { layouts: {}, streaming: {}, preferences: {}, ...sections },
  };
}

beforeEach(() => {
  store.clear();
  viewport.current = "desktop";
  localStorage.setItem("frigateDeviceId", "device");
});

describe("buildExportPayload layout fallback", () => {
  it("prefers the current screen size over the legacy layout", async () => {
    store.set(layoutKey("front"), legacy);
    store.set(deviceKey("front", "desktop"), large);
    store.set(deviceKey("front", "mobile"), small);
    const file = await buildExportPayload(["front"], "test", USER);
    expect(file.sections.layouts["front"]).toEqual(large);
    expect(file.sections.viewport_layouts?.["front"]).toEqual({
      desktop: large,
      mobile: small,
    });
  });

  it("uses the legacy layout when the current size has none", async () => {
    store.set(layoutKey("front"), legacy);
    store.set(deviceKey("front", "mobile"), small);
    const file = await buildExportPayload(["front"], "test", USER);
    expect(file.sections.layouts["front"]).toEqual(legacy);
  });

  it("uses another screen size when neither current nor legacy exist", async () => {
    viewport.current = "tablet";
    store.set(deviceKey("front", "mobile"), small);
    const file = await buildExportPayload(["front"], "test", USER);
    expect(file.sections.layouts["front"]).toEqual(small);
  });

  it("omits the group and the viewport section when nothing is saved", async () => {
    const file = await buildExportPayload(["front"], "test", USER);
    expect(file.sections.layouts).toEqual({});
    expect(file.sections).not.toHaveProperty("viewport_layouts");
  });

  it("keeps only the legacy layout when no screen size is saved", async () => {
    store.set(layoutKey("front"), legacy);
    const file = await buildExportPayload(["front"], "test", USER);
    expect(file.sections.layouts["front"]).toEqual(legacy);
    expect(file.sections).not.toHaveProperty("viewport_layouts");
  });
});

describe("summarizeImport viewport layouts", () => {
  it("counts groups that exist only as screen-size layouts, once each", () => {
    const summary = summarizeImport(
      makeFile({
        layouts: { front: large },
        viewport_layouts: {
          front: { desktop: large },
          yard: { mobile: small },
          empty: {},
        },
      }),
      ["front"],
      [],
    );
    expect(summary.layoutGroupCount).toBe(2);
    expect(summary.unknownLayoutGroups).toEqual(["yard"]);
  });

  it("sorts unknown groups and cameras", () => {
    const stream = {
      streamName: "main",
      streamType: "smart" as const,
      compatibilityMode: false,
      playAudio: false,
      volume: 1,
    };
    const summary = summarizeImport(
      makeFile({
        layouts: { zulu: small, alpha: small },
        streaming: {
          zulu: { yard: stream, attic: stream },
          alpha: { attic: stream },
        },
      }),
      [],
      [],
    );
    expect(summary.unknownLayoutGroups).toEqual(["alpha", "zulu"]);
    expect(summary.unknownStreamingGroups).toEqual(["alpha", "zulu"]);
    expect(summary.unknownCameras).toEqual(["attic", "yard"]);
  });
});

describe("applyImportPayload viewport layouts", () => {
  it("writes the file's current-size variant over the legacy layout", async () => {
    await applyImportPayload(
      makeFile({
        layouts: { front: legacy },
        viewport_layouts: { front: { desktop: large, mobile: small } },
      }),
      LAYOUTS_ONLY,
      USER,
    );
    expect(store.get(layoutKey("front"))).toEqual(legacy);
    expect(store.get(deviceKey("front", "desktop"))).toEqual(large);
    expect(store.get(deviceKey("front", "mobile"))).toEqual(small);
    expect(store.has(deviceKey("front", "tablet"))).toBe(false);
  });

  it("falls back to the legacy layout when the group has no current variant", async () => {
    await applyImportPayload(
      makeFile({
        layouts: { front: legacy, yard: medium },
        viewport_layouts: { front: { mobile: small } },
      }),
      LAYOUTS_ONLY,
      USER,
    );
    expect(store.get(deviceKey("front", "desktop"))).toEqual(legacy);
    expect(store.get(deviceKey("yard", "desktop"))).toEqual(medium);
    expect(store.get(deviceKey("front", "mobile"))).toEqual(small);
  });

  it("writes the current size for groups present only as variants", async () => {
    await applyImportPayload(
      makeFile({ viewport_layouts: { yard: { desktop: large } } }),
      LAYOUTS_ONLY,
      USER,
    );
    expect(store.get(deviceKey("yard", "desktop"))).toEqual(large);
    expect(store.has(layoutKey("yard"))).toBe(false);
  });

  it("writes no layouts when the layouts section is not selected", async () => {
    await applyImportPayload(
      makeFile({
        layouts: { front: legacy },
        viewport_layouts: { front: { desktop: large } },
      }),
      { layouts: false, streaming: false, preferences: false },
      USER,
    );
    expect(store.size).toBe(0);
  });
});

describe("parseUiSettingsFile player mode", () => {
  function fileWithPlayerMode(playerMode: unknown) {
    return JSON.stringify(
      makeFile({
        streaming: {
          home: {
            front: {
              streamName: "main",
              streamType: "smart",
              compatibilityMode: false,
              playAudio: false,
              volume: 1,
              playerMode,
            } as never,
          },
        },
      }),
    );
  }

  function frontSettings(result: ReturnType<typeof parseUiSettingsFile>) {
    if (!result.ok) {
      return undefined;
    }
    // the index can miss at runtime even though the record type says it cannot
    const front = (
      group: (typeof result.file.sections.streaming)[string] | undefined,
    ) => group?.["front"];
    return front(result.file.sections.streaming["home"]);
  }

  it("keeps a known player mode", () => {
    const result = parseUiSettingsFile(fileWithPlayerMode("webrtc"));
    expect(result.ok).toBe(true);
    expect(frontSettings(result)).toMatchObject({ playerMode: "webrtc" });
  });

  it("drops an unknown player mode instead of rejecting the file", () => {
    const result = parseUiSettingsFile(fileWithPlayerMode("hls"));
    expect(result.ok).toBe(true);
    expect(frontSettings(result)).toBeDefined();
    expect(frontSettings(result)?.playerMode).toBeUndefined();
  });
});
