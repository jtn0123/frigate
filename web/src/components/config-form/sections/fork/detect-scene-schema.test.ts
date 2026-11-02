import type { RJSFSchema } from "@rjsf/utils";
import { describe, expect, it } from "vitest";
import detect from "@/components/config-form/section-configs/detect";
import type { HiddenFieldContext } from "@/types/configForm";
import type { FrigateConfig } from "@/types/frigateConfig";
import { modifySchemaForSection } from "../section-special-cases";

const cfg = (value: unknown) => value as FrigateConfig;

const ctx = (scenes: string[], cameraScene?: string): HiddenFieldContext =>
  ({
    fullConfig: cfg({
      models: scenes.map((scene) => ({ scene })),
      detect: {},
    }),
    fullCameraConfig: cameraScene
      ? ({ detect: { scene: cameraScene } } as FrigateConfig["cameras"][string])
      : undefined,
    level: "camera",
  }) as HiddenFieldContext;

const schema: RJSFSchema = {
  type: "object",
  properties: { scene: { type: "string" }, fps: { type: "integer" } },
};

describe("detect scene choices", () => {
  it("offers the configured model scenes as the scene choices", () => {
    const result = modifySchemaForSection(
      "detect",
      "camera",
      schema,
      ctx(["default", "thermal"]),
    ) as { properties: { scene: RJSFSchema; fps: RJSFSchema } };

    expect(result.properties.scene.enum).toEqual(["default", "thermal"]);
    expect(result.properties.fps).toEqual({ type: "integer" });
  });

  it("leaves the schema alone without a context or a scene field", () => {
    expect(modifySchemaForSection("detect", "camera", schema)).toBe(schema);

    const noScene: RJSFSchema = { type: "object", properties: {} };
    expect(
      modifySchemaForSection("detect", "camera", noScene, ctx(["default"])),
    ).toBe(noScene);
  });

  it("hides the scene field until there is a choice to make", () => {
    const hidden = detect.base?.hiddenFields ?? [];
    const resolve = (context: HiddenFieldContext) =>
      hidden.flatMap((entry) =>
        typeof entry === "function" ? entry(context) : [entry],
      );

    expect(resolve(ctx(["default"]))).toContain("scene");
    expect(resolve(ctx(["default", "thermal"]))).not.toContain("scene");
    // a saved scene that no model uses is still shown so it can be changed
    expect(resolve(ctx(["default"], "garage"))).not.toContain("scene");
  });
});
