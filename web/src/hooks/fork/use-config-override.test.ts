import { renderHook } from "@testing-library/react";
import set from "lodash/set";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RJSFSchema } from "@rjsf/utils";
import type { FrigateConfig } from "@/types/frigateConfig";
import {
  OVERRIDABLE_SECTIONS,
  normalizeConfigValue,
  useAllCameraOverrides,
  useCameraSectionDeltas,
  useCamerasOverridingSection,
  useConfigOverride,
  useProfileSectionDeltas,
} from "@/hooks/use-config-override";

const fx = vi.hoisted(() => ({ schema: undefined as unknown }));

vi.mock("swr", () => ({
  default: (key: string) => ({
    data: key === "config/schema.json" ? fx.schema : undefined,
  }),
}));

const cfg = (value: unknown) => value as FrigateConfig;
const asSchema = (value: unknown) => value as RJSFSchema;

const FFMPEG = {
  path: "default",
  global_args: ["-hide_banner"],
  hwaccel_args: [],
  input_args: "preset-rtsp-generic",
  output_args: { record: "preset-record-generic" },
  retry_interval: 10,
  apple_compatibility: false,
  gpu: 0,
};

const FILTER = { min_area: 0, threshold: 0.7 };

function camera(
  detect: Record<string, unknown>,
  motion: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    detect,
    motion,
    record: { enabled: false, retain: { days: 1 } },
    objects: { track: ["person"], filters: { person: FILTER } },
    ffmpeg: { ...FFMPEG, inputs: [{ path: "rtsp://cam" }] },
    ...extra,
  };
}

function buildConfig(): FrigateConfig {
  return cfg({
    detect: { enabled: true, fps: 5 },
    record: { enabled: false, retain: { days: 1 } },
    motion: null,
    objects: { track: ["person"], filters: { person: FILTER } },
    ffmpeg: FFMPEG,
    model: { all_attributes: [], attributes_map: {} },
    cameras: {
      front: camera(
        {
          enabled: true,
          fps: 10,
          width: 1280,
          height: 720,
          enabled_in_config: true,
        },
        { threshold: 30, mask: { m1: { coordinates: "0,0,1,1" } } },
        {
          objects: {
            track: ["person", "car"],
            filters: { person: FILTER, car: FILTER },
          },
          ffmpeg: {
            ...FFMPEG,
            apple_compatibility: true,
            inputs: [{ path: "rtsp://front" }],
          },
          profiles: {
            night: {
              detect: { fps: 2 },
              record: { enabled: true },
              motion: { mask: { m2: { coordinates: "0,0" } }, threshold: 40 },
              ffmpeg: { inputs: [{ path: "rtsp://night" }], gpu: 1 },
            },
            empty: {},
          },
        },
      ),
      back: camera(
        { enabled: true, fps: 5, width: 640, height: 480 },
        { threshold: 25 },
      ),
      side: camera(
        { enabled: true, fps: 5, width: 640, height: 480 },
        { threshold: 25 },
      ),
      _replay_front: camera(
        { enabled: true, fps: 1, width: 640, height: 480 },
        { threshold: 99 },
      ),
    },
  });
}

const SCHEMA = asSchema({
  $defs: {
    CameraConfig: {
      properties: {
        motion: { $ref: "#/$defs/MotionConfig" },
        objects: { $ref: "#/$defs/ObjectConfig" },
      },
    },
    MotionConfig: {
      type: "object",
      properties: { threshold: { type: "integer", default: 30 } },
    },
    ObjectConfig: {
      type: "object",
      properties: {
        track: { type: "array", items: { type: "string" } },
        filters: {
          anyOf: [
            {
              type: "object",
              additionalProperties: { $ref: "#/$defs/FilterConfig" },
            },
            { type: "null" },
          ],
        },
      },
    },
    FilterConfig: {
      type: "object",
      properties: {
        min_area: { type: "integer", default: 0 },
        threshold: { type: "number", default: 0.7 },
      },
    },
  },
});

let config: FrigateConfig;

beforeEach(() => {
  fx.schema = undefined;
  config = buildConfig();
});

function override(
  sectionPath: string,
  cameraName?: string,
  compareFields?: string[],
  cfg: FrigateConfig | null = config,
) {
  return renderHook(() =>
    useConfigOverride({
      config: cfg ?? undefined,
      sectionPath,
      ...(cameraName === undefined ? {} : { cameraName }),
      ...(compareFields === undefined ? {} : { compareFields }),
    }),
  ).result.current;
}

describe("normalizeConfigValue", () => {
  it("strips internal fields at any depth", () => {
    expect(
      normalizeConfigValue({
        enabled_in_config: true,
        zones: [{ name: "a", raw_mask: "x", enabled_in_config: false }],
        nested: { genai_enabled_in_config: 1, keep: 2 },
        value: 3,
      }),
    ).toEqual({ zones: [{ name: "a" }], nested: { keep: 2 }, value: 3 });
    expect(normalizeConfigValue("plain")).toBe("plain");
  });
});

describe("useConfigOverride", () => {
  it("reports nothing without a config", () => {
    const result = override("detect", "front", undefined, null);
    expect(result.isOverridden).toBe(false);
    expect(result.globalValue).toBeUndefined();
    expect(result.getFieldOverride("fps")).toEqual({
      isOverridden: false,
      globalValue: undefined,
      cameraValue: undefined,
    });
    expect(result.resetToGlobal()).toBeUndefined();
  });

  it("returns the global values when no camera is selected", () => {
    const result = override("detect");
    expect(result.isOverridden).toBe(false);
    expect(result.cameraValue).toBe(config.detect);
    expect(result.getFieldOverride("fps")).toEqual({
      isOverridden: false,
      globalValue: 5,
      cameraValue: 5,
    });
    expect(result.resetToGlobal()).toBe(config.detect);
  });

  it("returns no camera value for an unknown camera", () => {
    const result = override("detect", "garage");
    expect(result.isOverridden).toBe(false);
    expect(result.globalValue).toBe(config.detect);
    expect(result.cameraValue).toBeUndefined();
    expect(result.getFieldOverride("fps").isOverridden).toBe(false);
    expect(result.resetToGlobal()).toBe(config.detect);
  });

  it("detects overridden fields and ignores auto-derived ones", () => {
    const result = override("detect", "front");
    expect(result.isOverridden).toBe(true);
    expect(result.cameraValue).toEqual({
      enabled: true,
      fps: 10,
      width: 1280,
      height: 720,
    });
    expect(result.getFieldOverride("fps")).toEqual({
      isOverridden: true,
      globalValue: 5,
      cameraValue: 10,
    });
    expect(result.getFieldOverride("width")).toEqual({
      isOverridden: false,
      globalValue: undefined,
      cameraValue: 1280,
    });
    expect(result.getFieldOverride("enabled").isOverridden).toBe(false);
    expect(result.resetToGlobal("fps")).toBe(5);
    expect(result.resetToGlobal()).toEqual({ enabled: true, fps: 5 });

    expect(override("detect", "back").isOverridden).toBe(false);
  });

  it("compares against the base config when a profile is active", () => {
    set(config, "cameras.front.base_config", {
      detect: { enabled: true, fps: 5 },
    });
    expect(override("detect", "front").isOverridden).toBe(false);
  });

  it("compares a global width once it is set explicitly", () => {
    set(config, "detect.width", 640);
    const result = override("detect", "back");
    expect(result.getFieldOverride("width").isOverridden).toBe(false);
    expect(override("detect", "front").getFieldOverride("width")).toEqual({
      isOverridden: true,
      globalValue: 640,
      cameraValue: 1280,
    });
  });

  it("uses the most common camera value when the global section is unset", () => {
    // back and side agree on 25; the replay camera is ignored
    expect(override("motion", "front").isOverridden).toBe(true);
    expect(override("motion", "back").isOverridden).toBe(false);
    // every path any camera sets joins the synthetic baseline
    expect(override("motion", "back").globalValue).toMatchObject({
      threshold: 25,
    });
  });

  it("uses schema defaults for an unset section once the schema loads", () => {
    fx.schema = SCHEMA;
    // front's mask is hidden, so only the threshold is compared
    expect(override("motion", "front").isOverridden).toBe(false);
    expect(override("motion", "back").isOverridden).toBe(true);
    expect(override("motion", "back").globalValue).toEqual({ threshold: 30 });
  });

  it("treats filters the camera adds for tracked labels as defaults", () => {
    expect(override("objects", "front").isOverridden).toBe(true);
    fx.schema = SCHEMA;
    const result = override("objects", "front", ["filters"]);
    expect(result.isOverridden).toBe(false);
    expect(override("objects", "front").isOverridden).toBe(true);
  });

  it("limits the comparison to the given fields", () => {
    expect(override("ffmpeg", "back", ["path", "gpu"]).isOverridden).toBe(
      false,
    );
    expect(
      override("ffmpeg", "front", ["apple_compatibility"]).isOverridden,
    ).toBe(true);
    // retry_interval is hidden at the camera level
    set(config, "cameras.front.ffmpeg.retry_interval", 20);
    expect(override("ffmpeg", "front", ["retry_interval"]).isOverridden).toBe(
      false,
    );
    expect(override("ffmpeg", "front", []).isOverridden).toBe(false);
  });
});

describe("useAllCameraOverrides", () => {
  function overrides(
    name: string | undefined,
    cfg: FrigateConfig | null = config,
  ) {
    return renderHook(() => useAllCameraOverrides(cfg ?? undefined, name))
      .result.current;
  }

  it("is empty without a config, camera or known camera", () => {
    expect(overrides(undefined)).toEqual([]);
    expect(overrides("front", null)).toEqual([]);
    expect(overrides("garage")).toEqual([]);
  });

  it("lists the sections a camera overrides", () => {
    const front = overrides("front");
    expect(front).toEqual(
      expect.arrayContaining(["detect", "motion", "objects", "ffmpeg"]),
    );
    expect(front).not.toContain("record");

    const back = overrides("back");
    expect(back).not.toContain("detect");
    expect(back).not.toContain("motion");
    expect(back).not.toContain("objects");
    expect(back).not.toContain("ffmpeg");
    expect(back).not.toContain("record");
  });

  it("keeps the section list in sync with the scoped compare fields", () => {
    expect(
      OVERRIDABLE_SECTIONS.find((s) => s.key === "ffmpeg")?.compareFields,
    ).toContain("retry_interval");
  });
});

describe("useCamerasOverridingSection", () => {
  function entries(section: string, cfg: FrigateConfig | null = config) {
    return renderHook(() =>
      useCamerasOverridingSection(cfg ?? undefined, section),
    ).result.current;
  }

  it("is empty without cameras or a section", () => {
    expect(entries("detect", null)).toEqual([]);
    expect(entries("")).toEqual([]);
  });

  it("lists camera-level deltas before profile ones", () => {
    expect(entries("detect")).toEqual([
      {
        camera: "front",
        fieldDeltas: [{ fieldPath: "fps", globalValue: 5, cameraValue: 10 }],
      },
    ]);
  });

  it("surfaces fields overridden only inside a profile", () => {
    expect(entries("record")).toEqual([
      {
        camera: "front",
        fieldDeltas: [
          {
            fieldPath: "enabled",
            globalValue: false,
            cameraValue: true,
            profileName: "night",
          },
        ],
      },
    ]);
  });

  it("skips mask paths and fields outside the compare list", () => {
    const motion = entries("motion");
    expect(motion).toEqual([
      {
        camera: "front",
        fieldDeltas: [
          { fieldPath: "threshold", globalValue: 25, cameraValue: 30 },
        ],
      },
    ]);

    expect(entries("ffmpeg")).toEqual([
      {
        camera: "front",
        fieldDeltas: [
          {
            fieldPath: "apple_compatibility",
            globalValue: false,
            cameraValue: true,
          },
          {
            fieldPath: "gpu",
            globalValue: 0,
            cameraValue: 1,
            profileName: "night",
          },
        ],
      },
    ]);
  });

  it("reports nested deltas by their full path", () => {
    set(config, "cameras.back.record", {
      enabled: false,
      retain: { days: 7 },
    });
    expect(entries("record")).toContainEqual({
      camera: "back",
      fieldDeltas: [
        { fieldPath: "retain.days", globalValue: 1, cameraValue: 7 },
      ],
    });
  });
});

describe("useCameraSectionDeltas", () => {
  function deltas(name: string | undefined, section: string) {
    return renderHook(() => useCameraSectionDeltas(config, name, section))
      .result.current;
  }

  it("is empty for missing inputs", () => {
    expect(deltas(undefined, "detect")).toEqual([]);
    expect(deltas("garage", "detect")).toEqual([]);
    expect(deltas("front", "")).toEqual([]);
  });

  it("lists field deltas and hides hidden fields", () => {
    expect(deltas("front", "detect")).toEqual([
      { fieldPath: "fps", globalValue: 5, cameraValue: 10 },
    ]);
    expect(deltas("front", "motion")).toEqual([
      { fieldPath: "threshold", globalValue: 25, cameraValue: 30 },
    ]);
    expect(deltas("back", "detect")).toEqual([]);
  });

  it("uses the compare fields for scoped sections", () => {
    expect(deltas("front", "ffmpeg")).toEqual([
      {
        fieldPath: "apple_compatibility",
        globalValue: false,
        cameraValue: true,
      },
    ]);
  });
});

describe("useProfileSectionDeltas", () => {
  function deltas(
    name: string | undefined,
    profile: string | undefined,
    section: string,
  ) {
    return renderHook(() =>
      useProfileSectionDeltas(config, name, profile, section),
    ).result.current;
  }

  it("is empty for missing inputs or profile sections", () => {
    expect(deltas(undefined, "night", "detect")).toEqual([]);
    expect(deltas("front", undefined, "detect")).toEqual([]);
    expect(deltas("garage", "night", "detect")).toEqual([]);
    expect(deltas("front", "empty", "detect")).toEqual([]);
  });

  it("diffs the profile against the camera base value", () => {
    expect(deltas("front", "night", "detect")).toEqual([
      {
        fieldPath: "fps",
        globalValue: 10,
        cameraValue: 2,
        profileName: "night",
      },
    ]);
  });

  it("skips hidden and out-of-scope fields", () => {
    expect(deltas("front", "night", "motion")).toEqual([
      {
        fieldPath: "threshold",
        globalValue: 30,
        cameraValue: 40,
        profileName: "night",
      },
    ]);
    expect(deltas("front", "night", "ffmpeg")).toEqual([
      {
        fieldPath: "gpu",
        globalValue: 0,
        cameraValue: 1,
        profileName: "night",
      },
    ]);
  });
});
