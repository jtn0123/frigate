import { describe, expect, it } from "vitest";
import type { FrigateConfig } from "@/types/frigateConfig";
import { buildConfigDataForPath, buildOverrides } from "@/utils/configUtil";
import { sanitizeOverridesForSection } from "./section-special-cases";

// /api/config serves a Frigate+ model with its path resolved to the cache file
// and its input shape filled from the Frigate+ model info
const resolvedPlusModel = {
  scene: "all",
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
        { scene: "all", devices: ["onnx", "onnx"], path: "plus://abc123" },
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
        { scene: "all", path: "plus://picked", width: 320 },
      ]),
    ).toEqual([{ scene: "all", path: "plus://picked" }]);
  });
});
