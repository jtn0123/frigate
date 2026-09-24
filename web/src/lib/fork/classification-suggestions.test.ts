import { describe, expect, it } from "vitest";
import {
  confirmBody,
  percent,
  suggestionsKey,
  type Suggestion,
} from "./classification-suggestions";

const JEV: Suggestion = {
  category: "van",
  source: "jev",
  score: 0.966,
  evidence: "a white van",
};

describe("classification suggestions", () => {
  it("asks nothing without a model or ids", () => {
    expect(suggestionsKey("", "a,b")).toBeNull();
    expect(suggestionsKey("vehicle_type", "")).toBeNull();
    expect(suggestionsKey("vehicle_type", "a,b")).toEqual([
      "classification/vehicle_type/suggestions",
      { ids: "a,b" },
    ]);
  });

  it("confirms the draft on every file of the event", () => {
    expect(confirmBody("evt-1", ["a.webp", "b.webp"], JEV)).toEqual({
      event_id: "evt-1",
      category: "van",
      training_files: ["a.webp", "b.webp"],
      source: "jev",
      score: 0.966,
      suggested_category: "van",
    });
  });

  it("rounds a score to a whole percent and has none for text", () => {
    expect(percent(JEV)).toBe(97);
    expect(percent({ ...JEV, source: "text", score: null })).toBeNull();
  });
});
