import { describe, expect, it } from "vitest";
import type { RJSFSchema } from "@rjsf/utils";
import type { CameraConfig, FrigateConfig } from "@/types/frigateConfig";
import type { JsonObject } from "@/types/configForm";
import type { SectionSavePayload } from "@/utils/configUtil";
import {
  CLONE_CATEGORIES,
  buildClonePreviewItems,
  buildClonedCameraPayloads,
  getCategoryDefaults,
  resolutionsMatch,
  type CloneCategoryKey,
} from "./cameraClone";

const cam = (value: unknown) => value as CameraConfig;
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

const mask = {
  driveway: {
    coordinates: "0,0,1,1",
    enabled_in_config: true,
    raw_coordinates: "0,0,1,1",
  },
};

const sourceCfg = cam({
  name: "front",
  type: "lpr",
  enabled: true,
  detect: {
    enabled: true,
    fps: 10,
    width: 1920,
    height: 1080,
    enabled_in_config: true,
  },
  ffmpeg: {
    global_args: ["-hide_banner"],
    inputs: [
      {
        path: "rtsp://*:*@cam/stream",
        roles: ["detect"],
        global_args: [],
        input_args: [],
      },
    ],
  },
  live: { height: 720, quality: 8, streams: { main: "front_main" } },
  motion: { threshold: 30, mask },
  objects: {
    track: ["person"],
    mask,
    filters: {
      person: { min_area: 500, mask },
      car: { mask: {} },
    },
  },
  profiles: { armed: { detect: { fps: 8 } } },
});

const fullConfig = cfg({
  detect: { enabled: true, fps: 5 },
  ffmpeg: { global_args: ["-hide_banner"] },
  live: { height: 720, quality: 8 },
  cameras: {
    front: sourceCfg,
    back: cam({
      name: "back",
      enabled: true,
      detect: { enabled: true, fps: 5, width: 1920, height: 1080 },
    }),
  },
});

function build(
  keys: CloneCategoryKey[],
  overrides: Partial<Parameters<typeof buildClonedCameraPayloads>[0]> = {},
) {
  return buildClonedCameraPayloads({
    sourceCfg,
    sourceName: "front",
    targetInput: "back",
    targetIsNew: false,
    selectedKeys: new Set(keys),
    fullConfig,
    fullSchema,
    ...overrides,
  });
}

describe("resolutionsMatch", () => {
  it("requires numeric dimensions on both sides", () => {
    expect(resolutionsMatch(undefined, { width: 1, height: 1 } as never)).toBe(
      false,
    );
    expect(
      resolutionsMatch({ width: 1 } as never, { width: 1, height: 1 } as never),
    ).toBe(false);
    expect(
      resolutionsMatch(
        { width: 1, height: 1 } as never,
        { height: 1 } as never,
      ),
    ).toBe(false);
  });

  it("compares exact dimensions", () => {
    expect(
      resolutionsMatch(
        { width: 1280, height: 720 } as never,
        { width: 1280, height: 720 } as never,
      ),
    ).toBe(true);
    expect(
      resolutionsMatch(
        { width: 1280, height: 720 } as never,
        { width: 1920, height: 1080 } as never,
      ),
    ).toBe(false);
  });
});

describe("getCategoryDefaults", () => {
  it("starts empty for existing cameras", () => {
    expect(getCategoryDefaults(false).size).toBe(0);
  });

  it("pre-selects defaults and forced categories for new cameras", () => {
    const selected = getCategoryDefaults(true);
    expect(selected.has("ffmpeg_live")).toBe(true);
    expect(selected.has("record")).toBe(true);
    expect(selected.has("onvif")).toBe(false);
    expect(selected.has("type")).toBe(false);
    const expected = CLONE_CATEGORIES.filter(
      (c) => c.defaultOnExisting || c.forcedForNewCamera,
    ).length;
    expect(selected.size).toBe(expected);
  });
});

describe("buildClonePreviewItems", () => {
  const payload = (
    basePath: string,
    overrides: JsonObject,
  ): SectionSavePayload => ({
    basePath,
    sanitizedOverrides: overrides,
    updateTopic: undefined,
    needsRestart: false,
    pendingDataKey: "x",
  });

  it("prefixes section paths relative to the camera", () => {
    const items = buildClonePreviewItems(
      [
        payload("cameras.back.detect", {
          fps: 10,
          stationary: { threshold: 50 },
        }),
      ],
      "back",
    );
    expect(items).toEqual([
      {
        scope: "camera",
        cameraName: "back",
        fieldPath: "detect.fps",
        value: 10,
      },
      {
        scope: "camera",
        cameraName: "back",
        fieldPath: "detect.stationary.threshold",
        value: 50,
      },
    ]);
  });

  it("uses bare paths for camera-level payloads and keeps foreign base paths", () => {
    const items = buildClonePreviewItems(
      [
        payload("cameras.back", { type: "lpr" }),
        payload("mqtt", { host: "h" }),
      ],
      "back",
    );
    expect(items.map((i) => i.fieldPath)).toEqual(["type", "mqtt.host"]);
  });

  it("falls back to the section path for an empty object payload", () => {
    const items = buildClonePreviewItems(
      [payload("cameras.back.zones", {})],
      "back",
    );
    expect(items).toEqual([
      { scope: "camera", cameraName: "back", fieldPath: "zones", value: {} },
    ]);
  });
});

describe("buildClonedCameraPayloads for an existing camera", () => {
  it("returns nothing when no categories are selected", () => {
    expect(build([])).toEqual([]);
  });

  it("copies the camera type as a restart-only payload", () => {
    expect(build(["type"])).toEqual([
      {
        basePath: "cameras.back",
        sanitizedOverrides: { type: "lpr" },
        updateTopic: undefined,
        needsRestart: true,
        pendingDataKey: "back::type",
      },
    ]);
    expect(
      build(["type"], { sourceCfg: cam({ ...sourceCfg, type: undefined }) }),
    ).toEqual([]);
  });

  it("diffs schema-driven sections against the target camera", () => {
    const [detect] = build(["detect"]);
    expect(detect).toEqual({
      basePath: "cameras.back.detect",
      sanitizedOverrides: { fps: 10 },
      updateTopic: "config/cameras/back/detect",
      needsRestart: true,
      pendingDataKey: "back::detect",
    });
  });

  it("orders type before sections and skips sections the source lacks", () => {
    const keys = build(["detect", "type"]).map((p) => p.pendingDataKey);
    expect(keys).toEqual(["back::type", "back::detect"]);
    expect(
      build(["detect"], {
        sourceCfg: cam({ ...sourceCfg, detect: undefined }),
      }),
    ).toEqual([]);
  });

  it("emits a standalone motion mask payload with runtime fields stripped", () => {
    expect(build(["motion_mask"])).toEqual([
      {
        basePath: "cameras.back.motion",
        sanitizedOverrides: { mask: { driveway: { coordinates: "0,0,1,1" } } },
        updateTopic: "config/cameras/back/motion",
        needsRestart: false,
        pendingDataKey: "back::motion.masks",
      },
    ]);
  });

  it("emits object masks and only the per-label masks that exist", () => {
    const [payload] = build(["object_masks"]);
    expect(payload.basePath).toBe("cameras.back.objects");
    expect(payload.updateTopic).toBe("config/cameras/back/objects");
    expect(payload.sanitizedOverrides).toEqual({
      mask: { driveway: { coordinates: "0,0,1,1" } },
      filters: { person: { mask: { driveway: { coordinates: "0,0,1,1" } } } },
    });
  });

  it("emits no mask payload when the source has no masks", () => {
    const bare = cam({
      ...sourceCfg,
      objects: { track: ["person"] },
      motion: {},
    });
    expect(build(["object_masks", "motion_mask"], { sourceCfg: bare })).toEqual(
      [],
    );
  });

  it("copies profiles wholesale as a deep clone", () => {
    const [payload] = build(["profiles"]);
    expect(payload.basePath).toBe("cameras.back.profiles");
    expect(payload.updateTopic).toBeUndefined();
    expect(payload.needsRestart).toBe(true);
    expect(payload.sanitizedOverrides).toEqual({
      armed: { detect: { fps: 8 } },
    });
    expect(payload.sanitizedOverrides).not.toBe(sourceCfg.profiles);
  });
});

describe("buildClonedCameraPayloads for a new camera", () => {
  const rawPaths = {
    cameras: {
      front: { ffmpeg: { inputs: [{ path: "rtsp://user:pw@cam/stream" }] } },
    },
  };

  it("bundles everything into one atomic add payload", () => {
    const payloads = build(["ffmpeg_live", "detect", "type"], {
      targetInput: "Front Yard",
      targetIsNew: true,
      rawPaths,
    });
    expect(payloads).toHaveLength(1);
    const [payload] = payloads;
    expect(payload.basePath).toBe("cameras.front_yard");
    expect(payload.updateTopic).toBe("config/cameras/front_yard/add");
    expect(payload.pendingDataKey).toBe("front_yard::add");
    expect(payload.needsRestart).toBe(true);
    expect(payload.sanitizedOverrides).toEqual({
      enabled: true,
      friendly_name: "Front Yard",
      type: "lpr",
      ffmpeg: {
        inputs: [{ path: "rtsp://user:pw@cam/stream", roles: ["detect"] }],
      },
      live: { streams: { main: "front_main" } },
      detect: { fps: 10, width: 1920, height: 1080 },
    });
  });

  it("keeps masked paths when raw paths are unavailable", () => {
    const [payload] = build(["ffmpeg_live"], {
      targetInput: "yard",
      targetIsNew: true,
    });
    const ffmpeg = payload.sanitizedOverrides.ffmpeg as {
      inputs: Array<{ path: string }>;
    };
    expect(ffmpeg.inputs[0].path).toBe("rtsp://*:*@cam/stream");
    expect(payload.sanitizedOverrides.friendly_name).toBeUndefined();
  });

  it("hashes names that are not valid ids and keeps the friendly name", () => {
    const [payload] = build([], {
      targetInput: "Front Yard!",
      targetIsNew: true,
    });
    expect(payload.basePath).toMatch(/^cameras\.cam/);
    expect(payload.sanitizedOverrides.friendly_name).toBe("Front Yard!");
  });
});
