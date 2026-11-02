import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { FrigateConfig } from "@/types/frigateConfig";
import {
  DEFAULT_SCENE,
  getSceneChoices,
  getSceneLabel,
} from "@/utils/modelUtil";

const t = ((key: string) => key) as TFunction;
const cfg = (value: unknown) => value as FrigateConfig;

const config = (
  scenes: (string | undefined)[],
  detectScene?: string,
): FrigateConfig =>
  cfg({
    models: scenes.map((scene) => ({ scene })),
    detect: detectScene ? { scene: detectScene } : {},
  });

describe("getSceneLabel", () => {
  it("translates the default scene and an unnamed one", () => {
    expect(getSceneLabel(t, DEFAULT_SCENE)).toBe(
      "detectionModels.scenes.default",
    );
    expect(getSceneLabel(t, undefined)).toBe("detectionModels.scenes.default");
    expect(getSceneLabel(t, "")).toBe("detectionModels.scenes.default");
  });

  it("shows a custom scene as it was named", () => {
    expect(getSceneLabel(t, "thermal")).toBe("thermal");
  });
});

describe("getSceneChoices", () => {
  it("lists model scenes once with the default first", () => {
    expect(
      getSceneChoices({
        fullConfig: config(["thermal", DEFAULT_SCENE, "thermal", undefined]),
        level: "global",
      }),
    ).toEqual([DEFAULT_SCENE, "thermal"]);
  });

  it("keeps a camera's saved scene that no model uses", () => {
    expect(
      getSceneChoices({
        fullConfig: config([DEFAULT_SCENE]),
        fullCameraConfig: {
          detect: { scene: "garage" },
        } as FrigateConfig["cameras"][string],
        level: "camera",
      }),
    ).toEqual([DEFAULT_SCENE, "garage"]);
  });

  it("reads the global detect scene at the global level", () => {
    expect(
      getSceneChoices({
        fullConfig: config([DEFAULT_SCENE], "thermal"),
        fullCameraConfig: {
          detect: { scene: "garage" },
        } as FrigateConfig["cameras"][string],
        level: "global",
      }),
    ).toEqual([DEFAULT_SCENE, "thermal"]);
  });

  it("falls back to the global detect scene for a camera without one", () => {
    expect(
      getSceneChoices({
        fullConfig: config([DEFAULT_SCENE, "thermal"], "thermal"),
        level: "camera",
      }),
    ).toEqual([DEFAULT_SCENE, "thermal"]);
  });
});
