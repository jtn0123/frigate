import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn((key: string) => Promise.resolve(store.get(key))),
  set: vi.fn((key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  }),
}));

import {
  applyImportPayload,
  buildExportPayload,
  exportFileName,
  hasImportableContent,
  parseUiSettingsFile,
  summarizeImport,
  UI_SETTINGS_FILE_TYPE,
  UiSettingsFile,
} from "./uiSettingsTransfer";
import { getUserNamespacedKey } from "@/hooks/use-user-persistence";

const USER = "alice";

function ns(key: string) {
  return getUserNamespacedKey(key, USER);
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

const STREAM = {
  streamName: "main",
  streamType: "smart" as const,
  compatibilityMode: false,
  playAudio: false,
  volume: 1,
};

beforeEach(() => {
  store.clear();
});

describe("parseUiSettingsFile", () => {
  it("rejects text that is not JSON", () => {
    expect(parseUiSettingsFile("{")).toEqual({
      ok: false,
      error: "invalid_json",
    });
  });

  it("rejects JSON from another source", () => {
    expect(parseUiSettingsFile('{"type":"other"}')).toEqual({
      ok: false,
      error: "wrong_type",
    });
    expect(parseUiSettingsFile("null")).toEqual({
      ok: false,
      error: "wrong_type",
    });
  });

  it("rejects a newer file version", () => {
    const text = JSON.stringify({ ...makeFile(), version: 99 });
    expect(parseUiSettingsFile(text)).toEqual({
      ok: false,
      error: "unsupported_version",
    });
  });

  it("rejects a malformed file", () => {
    const text = JSON.stringify({ ...makeFile(), sections: {} });
    expect(parseUiSettingsFile(text)).toEqual({
      ok: false,
      error: "invalid_schema",
    });
  });

  it("accepts a valid file", () => {
    const file = makeFile({
      layouts: { front: [{ i: "a", x: 0, y: 0, w: 1, h: 1, static: true }] },
    });
    const result = parseUiSettingsFile(JSON.stringify(file));
    expect(result.ok).toBe(true);
  });
});

describe("summarizeImport", () => {
  it("counts sections and lists unknown groups and cameras", () => {
    const file = makeFile({
      layouts: { front: [], gone: [] },
      streaming: { back: { cam1: STREAM, ghost: STREAM } },
      preferences: {
        autoLiveView: true,
        liveFallbackTimeout: 500,
        notAKey: 1,
      },
    });

    const summary = summarizeImport(file, ["front"], ["cam1"]);

    expect(summary).toEqual({
      layoutGroupCount: 2,
      streamingCameraCount: 2,
      preferenceCount: 1,
      unknownLayoutGroups: ["gone"],
      unknownStreamingGroups: ["back"],
      unknownCameras: ["ghost"],
    });
    expect(hasImportableContent(summary)).toBe(true);
  });

  it("reports an empty file as having nothing to import", () => {
    expect(hasImportableContent(summarizeImport(makeFile(), [], []))).toBe(
      false,
    );
  });
});

describe("exportFileName", () => {
  it("uses the local date", () => {
    expect(exportFileName(new Date(2026, 0, 5, 23, 30))).toBe(
      "frigate-ui-settings-2026-01-05.json",
    );
  });
});

describe("buildExportPayload", () => {
  it("reads namespaced keys, falls back to legacy keys and skips unset ones", async () => {
    store.set(ns("front-draggable-layout"), [{ i: "a", x: 0, y: 0, w: 1 }]);
    store.set("autoLiveView", false);
    store.set(ns("streaming-settings"), { front: { cam1: STREAM } });
    store.set("chat-auto-scroll", true);

    const payload = await buildExportPayload(["front", "back"], "0.18.0", USER);

    expect(payload.type).toBe(UI_SETTINGS_FILE_TYPE);
    expect(Object.keys(payload.sections.layouts)).toEqual(["front"]);
    expect(payload.sections.streaming).toEqual({ front: { cam1: STREAM } });
    expect(payload.sections.preferences).toEqual({
      autoLiveView: false,
      "chat-auto-scroll": true,
    });
  });
});

describe("applyImportPayload", () => {
  it("writes only selected sections and valid preferences", async () => {
    const file = makeFile({
      layouts: { front: [{ i: "a", x: 0, y: 0, w: 1, h: 1 }] },
      streaming: { front: { cam1: STREAM } },
      preferences: { autoLiveView: false, weekStartsOn: 5, bogus: true },
    });

    await applyImportPayload(
      file,
      { layouts: false, streaming: false, preferences: true },
      USER,
    );

    expect(store.get(ns("autoLiveView"))).toBe(false);
    expect(store.has(ns("weekStartsOn"))).toBe(false);
    expect(store.has(ns("bogus"))).toBe(false);
    expect(store.has(ns("front-draggable-layout"))).toBe(false);
    expect(store.has(ns("streaming-settings"))).toBe(false);
  });

  it("merges streaming settings per camera", async () => {
    store.set(ns("streaming-settings"), {
      front: { cam1: STREAM, cam2: STREAM },
      local: { cam3: STREAM },
    });
    const updated = { ...STREAM, streamType: "continuous" as const };
    const file = makeFile({
      layouts: { front: [{ i: "a", x: 0, y: 0, w: 1, h: 1 }] },
      streaming: { front: { cam1: updated } },
    });

    await applyImportPayload(
      file,
      { layouts: true, streaming: true, preferences: true },
      USER,
    );

    expect(store.get(ns("streaming-settings"))).toEqual({
      front: { cam1: updated, cam2: STREAM },
      local: { cam3: STREAM },
    });
    expect(store.get(ns("front-draggable-layout"))).toHaveLength(1);
  });
});

describe("viewport layouts", () => {
  const desktop = [{ i: "front", x: 0, y: 0, w: 6, h: 4 }];
  const tablet = [{ i: "front", x: 0, y: 0, w: 12, h: 8 }];

  it("exports each screen size and remaps it onto the importing browser", async () => {
    const { deviceLayoutKeyForGroup } = await import("@/lib/fork/live-layout");
    localStorage.setItem("frigateDeviceId", "source");
    store.set(ns(deviceLayoutKeyForGroup("front", "desktop")), desktop);
    store.set(ns(deviceLayoutKeyForGroup("front", "tablet")), tablet);
    const file = await buildExportPayload(["front"], "test", USER);
    expect(file.sections.viewport_layouts?.front).toEqual({ desktop, tablet });
    localStorage.setItem("frigateDeviceId", "destination");
    await applyImportPayload(
      file,
      { layouts: true, streaming: false, preferences: false },
      USER,
    );
    expect(store.get(ns(deviceLayoutKeyForGroup("front", "desktop")))).toEqual(
      desktop,
    );
    expect(store.get(ns(deviceLayoutKeyForGroup("front", "tablet")))).toEqual(
      tablet,
    );
  });

  it("imports an old backup over the current viewport without erasing other sizes", async () => {
    const { deviceLayoutKeyForGroup } = await import("@/lib/fork/live-layout");
    const { getViewportClass } = await import("@/hooks/fork/use-viewport");
    const current = getViewportClass();
    const other = current === "tablet" ? "desktop" : "tablet";
    store.set(ns(deviceLayoutKeyForGroup("front", other)), tablet);
    await applyImportPayload(
      makeFile({ layouts: { front: desktop } }),
      { layouts: true, streaming: false, preferences: false },
      USER,
    );
    expect(store.get(ns(deviceLayoutKeyForGroup("front", current)))).toEqual(
      desktop,
    );
    expect(store.get(ns(deviceLayoutKeyForGroup("front", other)))).toEqual(
      tablet,
    );
  });
});
