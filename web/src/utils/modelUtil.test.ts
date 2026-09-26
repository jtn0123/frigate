import { expect, it } from "vitest";
import type { FrigateConfig } from "@/types/frigateConfig";
import snapshot from "../../e2e/fixtures/mock-data/config-snapshot.json";
import {
  getModelForCamera,
  getPrimaryModel,
  getAllAttributes,
  isAttributeLabel,
  isAttributeOfLabel,
} from "./modelUtil";
it("selects scene-specific, all-scene and first models in fallback order", () => {
  const config = structuredClone(snapshot) as FrigateConfig;
  const base = config.models[0];
  config.models = [
    { ...base, scene: "vehicles" },
    { ...base, scene: "all" },
  ];
  config.cameras.front_door.detect.scene = "vehicles";
  expect(getModelForCamera(config, "front_door")).toBe(config.models[0]);
  expect(getModelForCamera(config, "missing")).toBe(config.models[1]);
  expect(getPrimaryModel(config)).toBe(config.models[1]);
  config.cameras.front_door.detect.scene = "animals";
  expect(getModelForCamera(config, "front_door")).toBe(config.models[1]);
  config.models.pop();
  expect(getPrimaryModel(config)).toBe(config.models[0]);
  config.models = [];
  expect(getPrimaryModel(config)).toBeUndefined();
  expect(getModelForCamera()).toBeUndefined();
});
it("deduplicates attributes and matches parent labels across models", () => {
  const config = structuredClone(snapshot) as FrigateConfig;
  const base = config.models[0];
  config.models = [
    { ...base, all_attributes: ["face"], attributes_map: { person: ["face"] } },
    {
      ...base,
      all_attributes: ["face", "plate"],
      attributes_map: { car: ["plate"] },
    },
  ];
  expect(getAllAttributes(config)).toEqual(["face", "plate"]);
  expect(isAttributeLabel(config, "plate")).toBe(true);
  expect(isAttributeLabel(config, "other")).toBe(false);
  expect(isAttributeOfLabel(config, "car", "plate")).toBe(true);
  expect(isAttributeOfLabel(config, "person", "plate")).toBe(false);
  expect(getAllAttributes()).toEqual([]);
  expect(isAttributeLabel(undefined, "face")).toBe(false);
  expect(isAttributeOfLabel(undefined, "person", "face")).toBe(false);
});
