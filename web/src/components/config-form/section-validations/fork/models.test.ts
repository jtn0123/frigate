import type { FormValidation } from "@rjsf/utils";
import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";
import { validateModelScenes } from "../models";

const t = ((key: string, options?: Record<string, string>) =>
  options?.scene
    ? `${key}:${options.scene}:${options.other}`
    : key) as unknown as TFunction;

function validate(formData: unknown): string[] {
  const addError = vi.fn<(message: string) => void>();
  validateModelScenes(formData, { addError } as unknown as FormValidation, t);
  return addError.mock.calls.map(([message]) => message);
}

describe("validateModelScenes", () => {
  it("ignores anything that is not a model list", () => {
    expect(validate(undefined)).toEqual([]);
    expect(validate({ scene: "default" })).toEqual([]);
  });

  it("accepts distinct scenes with a default model", () => {
    expect(
      validate([
        { scene: "default", devices: ["cpu"] },
        { scene: "thermal", devices: ["onnx"], path: "/config/thermal.onnx" },
      ]),
    ).toEqual([]);
  });

  it("requires a default model", () => {
    expect(validate([{ scene: "thermal", devices: ["cpu"] }])).toEqual([
      "models.defaultRequired",
    ]);
  });

  it("rejects two models with one scene", () => {
    expect(
      validate([
        { scene: "default", devices: ["onnx"], path: "/a.onnx" },
        { scene: "default", devices: ["onnx"], path: "/b.onnx" },
      ]),
    ).toEqual(["models.sceneDuplicate"]);
  });

  it("flags one model file split across scenes on one detector", () => {
    expect(
      validate([
        { scene: "default", devices: ["onnx"], path: "/config/model.onnx" },
        {
          scene: "garage",
          devices: ["onnx:1"],
          path: "/config/./cache/../model.onnx",
        },
      ]),
    ).toEqual(["models.sameModel:detectionModels.scenes.default:garage"]);
  });

  it("compares the built-in model a detector loads without a path", () => {
    expect(
      validate([
        { scene: "default", devices: ["cpu"] },
        { scene: "second", devices: ["cpu"] },
      ]),
    ).toEqual(["models.sameModel:detectionModels.scenes.default:second"]);
    expect(
      validate([
        { scene: "default", devices: ["edgetpu:usb"] },
        { scene: "second", devices: ["edgetpu:pci"] },
        { scene: "third", devices: ["openvino:GPU"] },
        { scene: "fourth", devices: ["openvino:CPU"] },
      ]),
    ).toEqual([
      "models.sameModel:detectionModels.scenes.default:second",
      "models.sameModel:third:fourth",
    ]);
  });

  it("keeps models on different detectors or with unknown paths apart", () => {
    expect(
      validate([
        { scene: "default", devices: ["onnx"], path: "/m.onnx" },
        { scene: "second", devices: ["openvino:GPU"], path: "/m.onnx" },
        { scene: "third", devices: ["hailo8l"] },
        { scene: "fourth", devices: ["hailo8l"] },
        "not a model",
      ]),
    ).toEqual([]);
  });

  it("compares plus models and relative paths as written", () => {
    expect(
      validate([
        { scene: "default", devices: ["onnx"], path: "plus://abc" },
        { scene: "second", devices: ["onnx"], path: "plus://abc" },
        { scene: "third", devices: ["onnx"], path: "../x/../m.onnx" },
        { scene: "fourth", devices: ["onnx"], path: "../m.onnx" },
      ]),
    ).toEqual([
      "models.sameModel:detectionModels.scenes.default:second",
      "models.sameModel:third:fourth",
    ]);
  });
});
