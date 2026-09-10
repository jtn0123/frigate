import { describe, expect, it } from "vitest";
import type { RJSFSchema } from "@rjsf/utils";
import type { CameraConfig, FrigateConfig } from "@/types/frigateConfig";
import type { ConfigSectionData, JsonObject } from "@/types/configForm";
import { REDACTED_CREDENTIAL_SENTINEL } from "@/lib/const";
import {
  buildConfigDataForPath,
  buildHiddenFieldContext,
  buildOverrides,
  flattenOverrides,
  getBaseCameraSectionValue,
  getEffectiveAttributeLabels,
  getEffectiveHiddenFields,
  getSectionConfig,
  mergeProfileOverrides,
  parseProfileFromSectionPath,
  pathMatchesHiddenPattern,
  prepareSectionSavePayload,
  requiresRestartForFieldPath,
  requiresRestartForOverrides,
  resolveHiddenFieldEntries,
  sanitizeSectionData,
  stripRedactedCredentials,
  unsetWithWildcard,
} from "./configUtil";

const cfg = (value: unknown) => value as FrigateConfig;

describe("stripRedactedCredentials", () => {
  it("removes sentinel values at any depth, including inside arrays", () => {
    const payload = {
      mqtt: { password: REDACTED_CREDENTIAL_SENTINEL, user: "u" },
      cameras: [{ path: REDACTED_CREDENTIAL_SENTINEL, roles: ["detect"] }],
      keep: 1,
    };
    const result = stripRedactedCredentials(payload);
    expect(result).toBe(payload);
    expect(result).toEqual({
      mqtt: { user: "u" },
      cameras: [{ roles: ["detect"] }],
      keep: 1,
    });
  });

  it("passes primitives and null through", () => {
    expect(stripRedactedCredentials(null)).toBeNull();
    expect(stripRedactedCredentials("x")).toBe("x");
  });
});

describe("profile helpers", () => {
  const config = cfg({
    cameras: {
      front: {
        detect: { fps: 5 },
        record: { enabled: true, retain: { days: 3 } },
        base_config: { detect: { fps: 10 } },
      },
    },
  });

  it("getBaseCameraSectionValue prefers base_config and falls back to the path", () => {
    expect(getBaseCameraSectionValue(config, "front", "detect")).toEqual({
      fps: 10,
    });
    expect(getBaseCameraSectionValue(config, "front", "record.retain")).toEqual(
      {
        days: 3,
      },
    );
    expect(getBaseCameraSectionValue(config, "back", "detect")).toBeUndefined();
    expect(
      getBaseCameraSectionValue(undefined, "front", "detect"),
    ).toBeUndefined();
    expect(
      getBaseCameraSectionValue(config, undefined, "detect"),
    ).toBeUndefined();
  });

  it("mergeProfileOverrides deep merges but replaces arrays wholesale", () => {
    const base = { a: { b: 1, c: 2 }, list: [1, 2, 3], keep: true };
    const result = mergeProfileOverrides(base, { a: { b: 9 }, list: [] });
    expect(result).toEqual({ a: { b: 9, c: 2 }, list: [], keep: true });
    expect(base.list).toEqual([1, 2, 3]);
  });

  it("parseProfileFromSectionPath recognises profile paths", () => {
    expect(parseProfileFromSectionPath("detect")).toEqual({
      isProfile: false,
      actualSection: "detect",
    });
    expect(parseProfileFromSectionPath("profiles.armed.detect")).toEqual({
      isProfile: true,
      profileName: "armed",
      actualSection: "detect",
    });
    expect(parseProfileFromSectionPath("profiles.armed.record.retain")).toEqual(
      {
        isProfile: true,
        profileName: "armed",
        actualSection: "record.retain",
      },
    );
    expect(parseProfileFromSectionPath("profiles.armed").isProfile).toBe(false);
  });
});

describe("buildOverrides", () => {
  it("returns undefined for empty current values", () => {
    expect(buildOverrides(undefined, 1, 1)).toBeUndefined();
    expect(buildOverrides(null, 1, 1)).toBeUndefined();
    expect(buildOverrides("", "x", "y")).toBeUndefined();
  });

  it("compares scalars against base, then defaults when base is absent", () => {
    expect(buildOverrides(5, 5, 1)).toBeUndefined();
    expect(buildOverrides(5, 1, 5)).toBe(5);
    expect(buildOverrides(5, undefined, 5)).toBeUndefined();
    expect(buildOverrides(5, undefined, 1)).toBe(5);
  });

  it("returns only the changed keys of an object", () => {
    expect(
      buildOverrides(
        { a: 1, b: { c: 2, d: 3 } },
        { a: 1, b: { c: 2, d: 4 } },
        undefined,
      ),
    ).toEqual({ b: { d: 3 } });
  });

  it("marks removed and nulled keys with an empty string", () => {
    expect(buildOverrides({ a: 1 }, { a: 1, gone: 2 }, undefined)).toEqual({
      gone: "",
    });
    expect(buildOverrides({ a: null }, { a: 1 }, undefined)).toEqual({ a: "" });
    expect(buildOverrides({ a: null }, {}, undefined)).toBeUndefined();
  });

  it("returns undefined when nothing changed", () => {
    expect(buildOverrides({ a: 1 }, { a: 1 }, undefined)).toBeUndefined();
    expect(buildOverrides({ a: 1 }, undefined, { a: 1 })).toBeUndefined();
  });

  it("returns whole arrays when they differ", () => {
    expect(buildOverrides([1, 2], [1, 2], undefined)).toBeUndefined();
    expect(buildOverrides([1, 2], undefined, [1, 2])).toBeUndefined();
    expect(buildOverrides([1, 3], [1, 2], undefined)).toEqual([1, 3]);
    expect(buildOverrides([], undefined, undefined)).toBeUndefined();
    expect(buildOverrides([], [1], undefined)).toEqual([]);
  });
});

describe("flattenOverrides", () => {
  it("emits one entry per leaf with dotted paths", () => {
    expect(
      flattenOverrides({ a: 1, b: { c: "x", d: [1, 2] }, e: null }),
    ).toEqual([
      { path: "a", value: 1 },
      { path: "b.c", value: "x" },
      { path: "b.d", value: [1, 2] },
      { path: "e", value: null },
    ]);
  });

  it("keeps empty objects as leaves and handles undefined", () => {
    expect(flattenOverrides({ a: {} })).toEqual([{ path: "a", value: {} }]);
    expect(flattenOverrides(undefined)).toEqual([]);
    expect(flattenOverrides(7)).toEqual([{ path: "", value: 7 }]);
  });
});

describe("unsetWithWildcard and sanitizeSectionData", () => {
  it("unsets literal paths and wildcard segments", () => {
    const obj: Record<string, unknown> = {
      filters: { person: { mask: 1, min: 2 }, car: { mask: 3 } },
      top: { inner: 1 },
    };
    unsetWithWildcard(obj, "filters.*.mask");
    unsetWithWildcard(obj, "top.inner");
    unsetWithWildcard(obj, "missing.*.x");
    expect(obj).toEqual({ filters: { person: { min: 2 }, car: {} }, top: {} });
  });

  it("unsets every child when the wildcard is the last segment", () => {
    const obj: Record<string, unknown> = { zones: { a: 1, b: 2 } };
    unsetWithWildcard(obj, "zones.*");
    expect(obj).toEqual({ zones: {} });
  });

  it("strips internal fields and hidden paths on a copy", () => {
    const data = {
      enabled: true,
      enabled_in_config: true,
      mask: { a: 1 },
      nested: { raw_mask: "x", keep: 1 },
    } as unknown as ConfigSectionData;
    const cleaned = sanitizeSectionData(data, ["mask", ""]);
    expect(cleaned).toEqual({ enabled: true, nested: { keep: 1 } });
    expect(data).toHaveProperty("mask");
    expect(sanitizeSectionData(data)).toEqual({
      enabled: true,
      mask: { a: 1 },
      nested: { keep: 1 },
    });
  });
});

describe("buildConfigDataForPath", () => {
  it("nests a dotted path into config_data", () => {
    expect(
      buildConfigDataForPath("cameras.front_door.detect", { fps: 5 }),
    ).toEqual({
      cameras: { front_door: { detect: { fps: 5 } } },
    });
    expect(buildConfigDataForPath("mqtt", "x")).toEqual({ mqtt: "x" });
  });
});

describe("restart detection", () => {
  it("uses the default when no restart list is configured", () => {
    expect(requiresRestartForOverrides({ a: 1 }, undefined)).toBe(true);
    expect(requiresRestartForOverrides({ a: 1 }, undefined, false)).toBe(false);
  });

  it("never restarts for an empty list or non-object overrides", () => {
    expect(requiresRestartForOverrides({ a: 1 }, [])).toBe(false);
    expect(requiresRestartForOverrides("x", ["a"])).toBe(false);
    expect(requiresRestartForOverrides(null, ["a"])).toBe(false);
  });

  it("matches literal paths", () => {
    expect(requiresRestartForOverrides({ a: { b: 1 } }, ["a.b"])).toBe(true);
    expect(requiresRestartForOverrides({ a: { c: 1 } }, ["a.b", ""])).toBe(
      false,
    );
  });

  it("matches wildcard paths across dicts and arrays", () => {
    expect(
      requiresRestartForOverrides({ inputs: [{ path: "x" }] }, [
        "inputs.*.path",
      ]),
    ).toBe(true);
    expect(
      requiresRestartForOverrides({ zones: { a: { coords: 1 } } }, [
        "zones.*.coords",
      ]),
    ).toBe(true);
    expect(
      requiresRestartForOverrides({ zones: { a: { other: 1 } } }, [
        "zones.*.coords",
      ]),
    ).toBe(false);
    expect(requiresRestartForOverrides({ zones: 5 }, ["zones.*.coords"])).toBe(
      false,
    );
  });

  it("supports numeric array indexes in literal and wildcard forms", () => {
    expect(
      requiresRestartForOverrides({ inputs: [{ path: "x" }] }, [
        "inputs.0.path",
      ]),
    ).toBe(true);
    expect(
      requiresRestartForOverrides({ inputs: [{ path: "x" }] }, ["inputs.x.*"]),
    ).toBe(false);
  });

  it("requiresRestartForFieldPath probes a synthetic override", () => {
    expect(
      requiresRestartForFieldPath(["inputs", 0, "path"], ["inputs.*.path"]),
    ).toBe(true);
    expect(requiresRestartForFieldPath(["fps"], ["width"])).toBe(false);
    expect(requiresRestartForFieldPath([], ["fps"])).toBe(false);
    expect(requiresRestartForFieldPath(["fps"], undefined, false)).toBe(false);
    expect(requiresRestartForFieldPath(["fps"], [])).toBe(false);
  });
});

describe("getSectionConfig", () => {
  it("returns an empty config for unknown sections", () => {
    expect(getSectionConfig("nope", "global")).toEqual({});
  });

  it("layers level overrides on the base and replaces arrays wholesale", () => {
    const camera = getSectionConfig("detect", "camera");
    expect(camera.restartRequired).toEqual([
      "fps",
      "width",
      "height",
      "min_initialized",
      "max_disappeared",
    ]);
    expect(camera.fieldOrder?.[0]).toBe("enabled");

    const replay = getSectionConfig("detect", "replay");
    expect(replay.fieldOrder).toEqual(["width", "height", "fps"]);
    expect(replay.hiddenFields).toContain("stationary");
    expect(replay.restartRequired).toEqual([]);
  });

  it("keeps base uiSchema when the level has none", () => {
    const objects = getSectionConfig("objects", "camera");
    expect(objects.uiSchema?.track["ui:widget"]).toBe("objectLabels");
    const global = getSectionConfig("objects", "global");
    expect(global.hiddenFields).toContain("genai.required_zones");
    expect(global.hiddenFields?.length).toBe(10);
  });
});

describe("hidden fields and attribute labels", () => {
  const config = cfg({
    model: { all_attributes: ["face", "license_plate"] },
    objects: { track: ["person", "face"] },
    cameras: {
      lpr_cam: { type: "lpr", objects: { track: ["license_plate"] } },
      front: { objects: { track: ["person"] } },
    },
  });

  it("getEffectiveAttributeLabels drops license_plate for LPR cameras only", () => {
    expect(getEffectiveAttributeLabels(config, undefined, "global")).toEqual([
      "face",
      "license_plate",
    ]);
    expect(
      getEffectiveAttributeLabels(config, config.cameras.lpr_cam, "camera"),
    ).toEqual(["face"]);
    expect(
      getEffectiveAttributeLabels(config, config.cameras.lpr_cam, "global"),
    ).toEqual(["face", "license_plate"]);
    expect(getEffectiveAttributeLabels(undefined, undefined, "camera")).toEqual(
      [],
    );
  });

  it("buildHiddenFieldContext resolves the camera only below global level", () => {
    expect(
      buildHiddenFieldContext(undefined, "camera", "front"),
    ).toBeUndefined();
    expect(
      buildHiddenFieldContext(config, "global", "front")?.fullCameraConfig,
    ).toBeUndefined();
    expect(
      buildHiddenFieldContext(config, "camera", "front")?.fullCameraConfig,
    ).toBe(config.cameras.front);
  });

  it("resolveHiddenFieldEntries expands functions only with a context", () => {
    const entries = ["a", () => ["b", "c"]];
    expect(resolveHiddenFieldEntries(entries, undefined)).toEqual(["a"]);
    expect(
      resolveHiddenFieldEntries(
        entries,
        buildHiddenFieldContext(config, "global"),
      ),
    ).toEqual(["a", "b", "c"]);
    expect(resolveHiddenFieldEntries(undefined, undefined)).toEqual([]);
  });

  it("getEffectiveHiddenFields hides untracked attribute filters per scope", () => {
    const hidden = getEffectiveHiddenFields(
      "objects",
      "camera",
      buildHiddenFieldContext(config, "camera", "front"),
    );
    expect(hidden).toContain("filters.face");
    expect(hidden).toContain("filters.license_plate");
    expect(hidden).not.toContain("filters.face.threshold");

    const lpr = getEffectiveHiddenFields(
      "objects",
      "camera",
      buildHiddenFieldContext(config, "camera", "lpr_cam"),
    );
    expect(lpr).toContain("filters.face");
    expect(lpr).not.toContain("filters.license_plate");
  });

  it("pathMatchesHiddenPattern handles prefixes and wildcards", () => {
    expect(pathMatchesHiddenPattern("streams", "streams")).toBe(true);
    expect(pathMatchesHiddenPattern("streams.a.b", "streams")).toBe(true);
    expect(pathMatchesHiddenPattern("streamsx", "streams")).toBe(false);
    expect(
      pathMatchesHiddenPattern("filters.person.mask", "filters.*.mask"),
    ).toBe(true);
    expect(
      pathMatchesHiddenPattern("filters.person.mask.x", "filters.*.mask"),
    ).toBe(true);
    expect(pathMatchesHiddenPattern("filters.person", "filters.*.mask")).toBe(
      false,
    );
    expect(
      pathMatchesHiddenPattern("filters.person.min", "filters.*.mask"),
    ).toBe(false);
    expect(pathMatchesHiddenPattern("x", "")).toBe(false);
  });
});

describe("prepareSectionSavePayload", () => {
  const detectDef: RJSFSchema = {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: true },
      fps: { type: "integer", default: 5 },
      width: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
      height: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
      enabled_in_config: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
        default: null,
      },
    },
  };
  const fullSchema: RJSFSchema = {
    $defs: {
      DetectConfig: detectDef,
      BirdseyeConfig: {
        type: "object",
        properties: { enabled: { type: "boolean", default: false } },
      },
      CameraConfig: {
        type: "object",
        properties: { detect: { $ref: "#/$defs/DetectConfig" } },
      },
    },
    properties: {
      detect: { $ref: "#/$defs/DetectConfig" },
      birdseye: { $ref: "#/$defs/BirdseyeConfig" },
    },
  };
  const config = cfg({
    detect: { enabled: true, fps: 5 },
    birdseye: { enabled: false },
    cameras: {
      front: {
        detect: {
          enabled: true,
          fps: 5,
          width: 1280,
          height: 720,
          enabled_in_config: true,
        },
        profiles: { armed: { detect: { fps: 8 } } },
      },
    },
  });

  it("diffs a camera section against the stored value", () => {
    const payload = prepareSectionSavePayload({
      pendingDataKey: "front::detect",
      pendingData: { enabled: true, fps: 10, width: 1280, height: 720 },
      config,
      fullSchema,
    });
    expect(payload).toEqual({
      basePath: "cameras.front.detect",
      sanitizedOverrides: { fps: 10 },
      updateTopic: "config/cameras/front/detect",
      needsRestart: true,
      pendingDataKey: "front::detect",
    });
  });

  it("does not request a restart for fields outside the restart list", () => {
    const payload = prepareSectionSavePayload({
      pendingDataKey: "front::detect",
      pendingData: { enabled: false, fps: 5, width: 1280, height: 720 },
      config,
      fullSchema,
    });
    expect(payload?.sanitizedOverrides).toEqual({ enabled: false });
    expect(payload?.needsRestart).toBe(false);
  });

  it("fans global camera-default sections out with a wildcard topic", () => {
    const payload = prepareSectionSavePayload({
      pendingDataKey: "detect",
      pendingData: { enabled: true, fps: 7 },
      config,
      fullSchema,
    });
    expect(payload?.basePath).toBe("detect");
    expect(payload?.sanitizedOverrides).toEqual({ fps: 7 });
    expect(payload?.updateTopic).toBe("config/cameras/*/detect");
  });

  it("uses a plain config topic for other global sections", () => {
    const payload = prepareSectionSavePayload({
      pendingDataKey: "birdseye",
      pendingData: { enabled: true },
      config,
      fullSchema,
    });
    expect(payload?.updateTopic).toBe("config/birdseye");
    expect(payload?.sanitizedOverrides).toEqual({ enabled: true });
  });

  it("handles profile sections without a topic or restart", () => {
    const payload = prepareSectionSavePayload({
      pendingDataKey: "front::profiles.armed.detect",
      pendingData: { enabled: false },
      config,
      fullSchema,
    });
    expect(payload).toEqual({
      basePath: "cameras.front.profiles.armed.detect",
      sanitizedOverrides: { enabled: false },
      updateTopic: undefined,
      needsRestart: false,
      pendingDataKey: "front::profiles.armed.detect",
    });
  });

  it("returns null when nothing changed, the section is unknown, or data is empty", () => {
    expect(
      prepareSectionSavePayload({
        pendingDataKey: "front::detect",
        pendingData: { enabled: true, fps: 5, width: 1280, height: 720 },
        config,
        fullSchema,
      }),
    ).toBeNull();
    expect(
      prepareSectionSavePayload({
        pendingDataKey: "front::nope",
        pendingData: { a: 1 },
        config,
        fullSchema,
      }),
    ).toBeNull();
    expect(
      prepareSectionSavePayload({
        pendingDataKey: "detect",
        pendingData: undefined,
        config,
        fullSchema,
      }),
    ).toBeNull();
  });

  it("treats a missing stored section as empty and diffs against defaults", () => {
    const payload = prepareSectionSavePayload({
      pendingDataKey: "back::detect",
      pendingData: { enabled: true, fps: 5, width: 640 } as JsonObject,
      config: cfg({ ...config, cameras: { back: {} as CameraConfig } }),
      fullSchema,
    });
    expect(payload?.sanitizedOverrides).toEqual({ width: 640 });
  });
});
