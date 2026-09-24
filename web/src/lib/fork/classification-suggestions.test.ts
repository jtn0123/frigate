import { describe, expect, it, vi } from "vitest";
import {
  confirmBody,
  draftCount,
  draftsToFile,
  percent,
  pickerProps,
  reportKey,
  suggestionsKey,
  type EventSuggestion,
  type Suggestion,
  datasetImagePath,
  groupScore,
  orderGroups,
  usableFiles,
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

  it("lists the drafts on a page with every image of their events", () => {
    const entry: EventSuggestion = {
      text: null,
      jev: JEV,
      jev_status: "answered",
      suggestion: JEV,
      conflict: false,
    };
    const groups = {
      a: [{ filename: "a-1.webp" }, { filename: "a-2.webp" }],
      b: [{ filename: "b-1.webp" }],
      c: [] as { filename: string }[],
    };
    expect(draftsToFile(undefined, groups)).toEqual([]);
    expect(
      draftsToFile(
        { a: entry, b: { ...entry, suggestion: null }, c: entry },
        groups,
      ),
    ).toEqual([
      { eventId: "a", files: ["a-1.webp", "a-2.webp"], suggestion: JEV },
    ]);
  });

  it("leaves crops too small to train on out of file-all (fork I50)", () => {
    const entry: EventSuggestion = {
      text: null,
      jev: JEV,
      jev_status: "answered",
      suggestion: JEV,
      conflict: false,
    };
    const groups = {
      a: [{ filename: "a-1.webp" }, { filename: "a-2.webp" }],
      b: [{ filename: "b-1.webp" }],
    };
    expect(usableFiles(["x", "y"], undefined)).toEqual(["x", "y"]);
    expect(usableFiles(["x", "y"], [])).toEqual(["x", "y"]);
    expect(usableFiles(["x", "y"], ["y"])).toEqual(["x"]);
    expect(
      draftsToFile({ a: entry, b: entry }, groups, {
        a: ["a-2.webp"],
        b: ["b-1.webp"],
      }),
    ).toEqual([{ eventId: "a", files: ["a-1.webp"], suggestion: JEV }]);
  });

  it("orders the least sure events first when asked (fork I49)", () => {
    const groups = {
      newest: [{ score: 0.95 }, { score: 0.6 }],
      middle: [{ score: Number.NaN }],
      oldest: [{ score: 0.6 }],
    };
    expect(groupScore(groups.newest)).toBe(0.95);
    expect(groupScore(groups.middle)).toBe(0);
    expect(groupScore([])).toBe(0);
    expect(orderGroups(groups, false).map(([id]) => id)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
    expect(orderGroups(groups, true).map(([id]) => id)).toEqual([
      "middle",
      "oldest",
      "newest",
    ]);
    expect(
      orderGroups({ a: [{ score: 0.5 }], b: [{ score: 0.5 }] }, true).map(
        ([id]) => id,
      ),
    ).toEqual(["a", "b"]);
  });

  it("builds the dataset image path (fork I52)", () => {
    expect(datasetImagePath("vehicle_type", "mail truck", "a b.png")).toBe(
      "clips/vehicle_type/dataset/mail%20truck/a%20b.png",
    );
  });

  it("rounds a score to a whole percent and has none for text", () => {
    expect(percent(JEV)).toBe(97);
    expect(percent({ ...JEV, source: "text", score: null })).toBeNull();
  });
});
