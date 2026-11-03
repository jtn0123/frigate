import { describe, expect, it } from "vitest";
import type { FrigateConfig } from "@/types/frigateConfig";
import { buildConfigDataForPath, buildOverrides } from "@/utils/configUtil";
import type { HiddenFieldContext } from "@/types/configForm";
import type { RJSFSchema } from "@rjsf/utils";
import {
  modifySchemaForSection,
  sanitizeOverridesForSection,
} from "./section-special-cases";

// /api/config serves a Frigate+ model with its path resolved to the cache file
// and its input shape filled from the Frigate+ model info
const resolvedPlusModel = {
  scene: "default",
  devices: ["onnx"],
  path: "/config/model_cache/abc123",
  width: 640,
  height: 640,
  input_tensor: "nchw",
  input_pixel_format: "bgr",
  input_dtype: "float",
  model_type: "yolo-generic",
};

const customModel = {
  scene: "night",
  devices: ["cpu"],
  path: "/models/night.onnx",
  width: 320,
  height: 320,
  model_type: "ssd",
};

const asConfig = (value: unknown) => value as Pick<FrigateConfig, "models">;

const config = asConfig({
  models: [
    { ...resolvedPlusModel, plus: { id: "abc123" } },
    { ...customModel, plus: null },
  ],
});

describe("sanitizeOverridesForSection", () => {
  it("writes a Frigate+ model back as plus://<id> on the per-section save path", () => {
    // mirrors BaseSection.handleSave: overrides against the saved list, then
    // the section sanitizer, then the config/set payload
    const saved = [resolvedPlusModel, customModel];
    const pending = [
      { ...resolvedPlusModel, devices: ["onnx", "onnx"] },
      customModel,
    ];
    const overrides = buildOverrides(pending, saved, undefined);

    const payload = buildConfigDataForPath(
      "models",
      sanitizeOverridesForSection("models", "global", overrides, config),
    );

    expect(payload).toEqual({
      models: [
        { scene: "default", devices: ["onnx", "onnx"], path: "plus://abc123" },
        customModel,
      ],
    });
  });

  it("keeps an unchanged models section a no-op", () => {
    expect(
      sanitizeOverridesForSection("models", "global", undefined, config),
    ).toBeUndefined();
  });

  it("still rewrites a newly picked Frigate+ model without a config", () => {
    expect(
      sanitizeOverridesForSection("models", "global", [
        { scene: "default", path: "plus://picked", width: 320 },
      ]),
    ).toEqual([{ scene: "default", path: "plus://picked" }]);
  });
});

describe("modifySchemaForSection objects", () => {
  const filterConfig: RJSFSchema = {
    type: "object",
    properties: {
      min_score: { type: "number", default: 0.5 },
      min_area: { anyOf: [{ type: "integer" }, { type: "number" }] },
    },
  };
  const objectsSchema: RJSFSchema = {
    type: "object",
    properties: {
      filters: { type: "object", additionalProperties: filterConfig },
    },
  };
  const fullConfig: unknown = {
    models: [{ all_attributes: ["face"] }],
    objects: { track: ["face", "person"] },
  };
  const ctx = (): HiddenFieldContext => ({
    fullConfig: fullConfig as FrigateConfig,
    level: "global",
  });

  it("promotes tracked labels, keeping the model's min_score for attributes", () => {
    const result = modifySchemaForSection(
      "objects",
      "global",
      objectsSchema,
      ctx(),
    );
    const filters = (result?.properties?.filters as RJSFSchema).properties!;
    expect(Object.keys(filters)).toEqual(["face", "person"]);
    const face = filters.face as RJSFSchema;
    expect(face.properties?.min_score).toEqual({
      type: "number",
      default: 0.5,
    });
    expect(face.properties?.min_area).toEqual({ type: "number" });
    expect((filters.person as RJSFSchema).title).toBe("person");
  });

  it("falls back to a plain number when the filter schema has no min_score", () => {
    const schema: RJSFSchema = {
      type: "object",
      properties: {
        filters: {
          type: "object",
          additionalProperties: { type: "object", properties: {} },
        },
      },
    };
    const result = modifySchemaForSection("objects", "global", schema, ctx());
    const face = (result?.properties?.filters as RJSFSchema).properties!
      .face as RJSFSchema;
    expect(face.properties?.min_score).toEqual({ type: "number" });
  });

  it("leaves a schema without filters unchanged", () => {
    const schema: RJSFSchema = { type: "object", properties: {} };
    expect(modifySchemaForSection("objects", "global", schema, ctx())).toBe(
      schema,
    );
  });
});
