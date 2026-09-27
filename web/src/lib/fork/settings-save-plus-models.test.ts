import { describe, expect, it } from "vitest";
import { restorePlusModelPaths } from "./settings-save-plus-models";

const savedPlus = [
  { path: "/config/model_cache/abc", plus: { id: "abc" } },
  { path: "/models/custom.onnx", plus: null },
] as Parameters<typeof restorePlusModelPaths>[1];

describe("restorePlusModelPaths", () => {
  it("returns non-list values unchanged", () => {
    expect(restorePlusModelPaths(undefined, savedPlus)).toBeUndefined();
    const value = { scene: "all" };
    expect(restorePlusModelPaths(value, savedPlus)).toBe(value);
  });

  it("leaves non-object entries and models without a path alone", () => {
    const pathless = { scene: "all", width: 320 };
    expect(restorePlusModelPaths([null, "x", pathless], savedPlus)).toEqual([
      null,
      "x",
      pathless,
    ]);
  });

  it("keeps a custom model that shares no path with a saved Frigate+ model", () => {
    const custom = { path: "/models/custom.onnx", width: 416 };
    const [result] = restorePlusModelPaths([custom], savedPlus) as unknown[];
    expect(result).toBe(custom);
  });

  it("treats a resolved cache path as custom when no saved models are known", () => {
    const model = { path: "/config/model_cache/abc", width: 640 };
    const [result] = restorePlusModelPaths([model], undefined) as unknown[];
    expect(result).toBe(model);
  });

  it("does not treat an empty plus:// path as a Frigate+ model", () => {
    const model = { path: "plus://", width: 640 };
    const [result] = restorePlusModelPaths([model], savedPlus) as unknown[];
    expect(result).toBe(model);
  });

  it("restores the reference for a model matched by its resolved path", () => {
    expect(
      restorePlusModelPaths(
        [{ scene: "indoor", path: "/config/model_cache/abc", height: 640 }],
        savedPlus,
      ),
    ).toEqual([{ scene: "indoor", path: "plus://abc" }]);
  });
});
