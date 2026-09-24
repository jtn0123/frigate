import { describe, expect, it, vi } from "vitest";
import {
  confirmBody,
  draftCount,
  percent,
  pickerProps,
  reportKey,
  suggestionsKey,
  type EventSuggestion,
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

  it("records an override next to the draft it replaced", () => {
    expect(confirmBody("evt-1", ["a.webp"], JEV, "suv")).toMatchObject({
      category: "suv",
      suggested_category: "van",
      source: "jev",
    });
  });

  it("routes the picker through confirm only when the event has a draft", () => {
    const entry: EventSuggestion = {
      text: null,
      jev: JEV,
      jev_status: "answered",
      suggestion: JEV,
      conflict: false,
    };
    const run = vi.fn<(suggestion: Suggestion, category: string) => void>();

    expect(pickerProps(undefined, run)).toEqual({});
    expect(pickerProps({ ...entry, suggestion: null }, run)).toEqual({});

    const props = pickerProps(entry, run);
    props.onCategorize?.("suv");
    expect(run).toHaveBeenCalledWith(JEV, "suv");
  });

  it("keys the report by model and counts the drafts on a page", () => {
    expect(reportKey("")).toBeNull();
    expect(reportKey("vehicle_type")).toBe(
      "classification/vehicle_type/suggestions/report",
    );
    const entry: EventSuggestion = {
      text: null,
      jev: JEV,
      jev_status: "answered",
      suggestion: JEV,
      conflict: false,
    };
    expect(draftCount(undefined)).toBe(0);
    expect(draftCount({ a: entry, b: { ...entry, suggestion: null } })).toBe(1);
  });

  it("rounds a score to a whole percent and has none for text", () => {
    expect(percent(JEV)).toBe(97);
    expect(percent({ ...JEV, source: "text", score: null })).toBeNull();
  });
});
