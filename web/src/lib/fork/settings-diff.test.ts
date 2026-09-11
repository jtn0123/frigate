import { describe, expect, it } from "vitest";
import type { RJSFSchema } from "@rjsf/utils";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { ConfigSectionData } from "@/types/configForm";
import {
  computeSettingsDiff,
  diffValues,
  getSettingsDiff,
} from "./settings-diff";

const cfg = (value: unknown) => value as FrigateConfig;

const fullSchema: RJSFSchema = {
  $defs: {
    DetectConfig: {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
        fps: { type: "integer", default: 5 },
        width: {
          anyOf: [{ type: "integer" }, { type: "null" }],
          default: null,
        },
        height: {
          anyOf: [{ type: "integer" }, { type: "null" }],
          default: null,
        },
        enabled_in_config: {
          anyOf: [{ type: "boolean" }, { type: "null" }],
          default: null,
        },
      },
    },
    CameraConfig: {
      type: "object",
      properties: { detect: { $ref: "#/$defs/DetectConfig" } },
    },
  },
  properties: { detect: { $ref: "#/$defs/DetectConfig" } },
};

const config = cfg({
  detect: { enabled: true, fps: 5, width: 1280, height: 720 },
  go2rtc: { streams: { front: "rtsp://user:pw@cam/stream" } },
  detectors: { coral: { type: "edgetpu", device: "usb" } },
  cameras: {
    front: {
      detect: { enabled: true, fps: 5, width: 1280, height: 720 },
    },
  },
});

describe("diffValues", () => {
  it("lists changed leaves with old and new values, sorted by path", () => {
    expect(
      diffValues(
        { a: 1, nested: { b: "x", c: true }, gone: 1 },
        { a: 2, nested: { b: "x", c: false }, added: [1] },
      ),
    ).toEqual([
      { path: "a", oldValue: 1, newValue: 2 },
      { path: "added", oldValue: undefined, newValue: [1] },
      { path: "gone", oldValue: 1, newValue: undefined },
      { path: "nested.c", oldValue: true, newValue: false },
    ]);
  });
});

describe("computeSettingsDiff", () => {
  it("returns nothing without a config", () => {
    expect(
      computeSettingsDiff({ detect: { fps: 1 } }, undefined, fullSchema),
    ).toEqual([]);
  });

  it("pairs schema-backed overrides with the stored value and restart flag", () => {
    const pending: Record<string, ConfigSectionData> = {
      detect: { enabled: true, fps: 10, width: 1280, height: 720 },
    };
    const diff = computeSettingsDiff(pending, config, fullSchema).at(0);
    expect(diff?.scope).toBe("global");
    expect(diff?.section).toBe("detect");
    expect(diff?.needsRestart).toBe(true);
    expect(diff?.changes).toEqual([{ path: "fps", oldValue: 5, newValue: 10 }]);
  });

  it("scopes camera entries and skips sections with no effective change", () => {
    const pending: Record<string, ConfigSectionData> = {
      "front::detect": { enabled: false, fps: 5, width: 1280, height: 720 },
      detect: { enabled: true, fps: 5, width: 1280, height: 720 },
    };
    const diffs = computeSettingsDiff(pending, config, fullSchema);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      scope: "camera",
      cameraName: "front",
      section: "detect",
      changes: [{ path: "enabled", oldValue: true, newValue: false }],
    });
  });

  it("masks go2rtc credentials and marks detectors as restart-required", () => {
    const pending: Record<string, ConfigSectionData> = {
      go2rtc_streams: {
        front: ["rtsp://user:pw@cam/stream2"],
        back: ["rtsp://b"],
      },
      detectors: { coral: { type: "edgetpu", device: "pci" } },
    };
    const diffs = computeSettingsDiff(pending, config, fullSchema);
    const streams = diffs.find((d) => d.section === "go2rtc.streams");
    expect(streams?.needsRestart).toBe(false);
    expect(streams?.changes.map((c) => c.path)).toEqual(["back", "front"]);
    const front = streams?.changes.find((change) => change.path === "front");
    expect(JSON.stringify(front?.oldValue)).not.toContain("pw");
    const detectors = diffs.find((d) => d.section === "detectors");
    expect(detectors?.needsRestart).toBe(true);
    expect(detectors?.changes).toEqual([
      { path: "coral.device", oldValue: "usb", newValue: "pci" },
    ]);
  });

  it("does not throw when go2rtc.streams is missing from the config", () => {
    const pending: Record<string, ConfigSectionData> = {
      go2rtc_streams: { front: ["rtsp://front"] },
    };
    const diffs = computeSettingsDiff(pending, cfg({ go2rtc: {} }), fullSchema);
    const streams = diffs.find((d) => d.section === "go2rtc.streams");
    expect(streams).toBeDefined();
    expect(streams?.changes.some((change) => change.path === "front")).toBe(
      true,
    );
  });

  it("memoizes on input identity", () => {
    const pending: Record<string, ConfigSectionData> = { detect: { fps: 1 } };
    const first = getSettingsDiff(pending, config, fullSchema);
    expect(getSettingsDiff(pending, config, fullSchema)).toBe(first);
    expect(getSettingsDiff({ ...pending }, config, fullSchema)).not.toBe(first);
  });
});
