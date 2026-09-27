import { describe, expect, it } from "vitest";
import type { RJSFSchema } from "@rjsf/utils";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { ConfigSectionData } from "@/types/configForm";
import {
  computeSettingsDiff,
  diffValues,
  getSettingsDiff,
} from "./settings-diff";

const section = (value: unknown) => value as ConfigSectionData;
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
  models: [{ scene: "all", devices: ["edgetpu:usb"] }],
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

  it("treats an empty object and an array as leaf values", () => {
    expect(
      diffValues(
        { empty: {}, values: [1, 2] },
        { empty: { flag: true }, values: [1, 3] },
      ),
    ).toEqual([
      { path: "empty", oldValue: {}, newValue: undefined },
      { path: "empty.flag", oldValue: undefined, newValue: true },
      { path: "values", oldValue: [1, 2], newValue: [1, 3] },
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

  it("masks go2rtc credentials and marks models as restart-required", () => {
    const pending: Record<string, ConfigSectionData> = {
      go2rtc_streams: {
        front: ["rtsp://user:pw@cam/stream2"],
        back: ["rtsp://b"],
      },
      models: section([{ scene: "all", devices: ["edgetpu:pci"] }]),
    };
    const diffs = computeSettingsDiff(pending, config, fullSchema);
    const streams = diffs.find((d) => d.section === "go2rtc.streams");
    expect(streams?.needsRestart).toBe(false);
    expect(streams?.changes.map((c) => c.path)).toEqual(["back", "front"]);
    const front = streams?.changes.find((change) => change.path === "front");
    expect(JSON.stringify(front?.oldValue)).not.toContain("pw");
    const detectors = diffs.find((d) => d.section === "models");
    expect(detectors?.needsRestart).toBe(true);
    expect(detectors?.changes).toEqual([
      {
        path: "0.devices",
        oldValue: ["edgetpu:usb"],
        newValue: ["edgetpu:pci"],
      },
    ]);
  });

  it("shows changed and removed model fields while hiding runtime metadata", () => {
    const diffs = computeSettingsDiff(
      {
        models: section([
          { scene: "all", devices: ["cpu"], path: "plus://new" },
        ]),
      },
      cfg({
        models: [
          {
            scene: "all",
            devices: ["cpu"],
            path: "/models/old.onnx",
            width: 320,
            colormap: {},
            all_attributes: ["face"],
            plus: { name: "old" },
          },
        ],
      }),
      undefined,
    );
    expect(diffs[0]?.changes).toEqual([
      { path: "0.path", oldValue: "/models/old.onnx", newValue: "plus://new" },
      { path: "0.width", oldValue: 320, newValue: undefined },
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

  it("shows a removed model even without a schema", () => {
    const diffs = computeSettingsDiff(
      { models: section([]), detect: { fps: 20 } },
      config,
      undefined,
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.changes).toEqual([
      { path: "", oldValue: undefined, newValue: {} },
      { path: "0.devices", oldValue: ["edgetpu:usb"], newValue: undefined },
      { path: "0.scene", oldValue: "all", newValue: undefined },
    ]);
  });

  it("sorts global changes before camera changes and camera names alphabetically", () => {
    const cfgWithCameras = cfg({
      ...config,
      cameras: {
        zebra: config.cameras["front"],
        alpha: config.cameras["front"],
      },
    });
    const diffs = computeSettingsDiff(
      {
        "zebra::detect": { enabled: false, fps: 5, width: 1280, height: 720 },
        "alpha::detect": { enabled: false, fps: 5, width: 1280, height: 720 },
        detect: { enabled: true, fps: 10, width: 1280, height: 720 },
      },
      cfgWithCameras,
      fullSchema,
    );
    expect(diffs.map((diff) => diff.pendingKey)).toEqual([
      "detect",
      "alpha::detect",
      "zebra::detect",
    ]);
  });
});
