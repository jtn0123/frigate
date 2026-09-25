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
  allTooSmall,
  answeredImageCount,
  draftImageCount,
  draftsPerClass,
  draftsToRun,
  isAlreadyAccepted,
  serverMessage,
  tinyImageCount,
  modelLabel,
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

  it("flags drafts whose every crop is tiny without dropping them (fork I50)", () => {
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
    expect(allTooSmall(["x", "y"], undefined)).toBe(false);
    expect(allTooSmall(["x", "y"], ["y"])).toBe(false);
    expect(allTooSmall(["x", "y"], ["x", "y"])).toBe(true);
    expect(allTooSmall([], [])).toBe(false);
    const drafts = draftsToFile({ a: entry, b: entry }, groups);
    expect(drafts).toEqual([
      { eventId: "a", files: ["a-1.webp", "a-2.webp"], suggestion: JEV },
      { eventId: "b", files: ["b-1.webp"], suggestion: JEV },
    ]);
    expect(tinyImageCount(drafts, { a: ["a-2.webp"], b: ["b-1.webp"] })).toBe(
      1,
    );
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

  it("marks Accept all's calls as bulk and nothing else", () => {
    expect(
      confirmBody("evt-1", ["a.webp"], JEV, undefined, true),
    ).toMatchObject({ category: "van", bulk: true });
    expect(confirmBody("evt-1", ["a.webp"], JEV)).not.toHaveProperty("bulk");
  });

  it("tells an already accepted group from a real failure", () => {
    expect(isAlreadyAccepted(404, { message: "already accepted" })).toBe(true);
    expect(isAlreadyAccepted(404, { message: "Unknown model" })).toBe(false);
    expect(isAlreadyAccepted(400, { message: "already accepted" })).toBe(false);
    expect(isAlreadyAccepted(undefined, undefined)).toBe(false);
    expect(serverMessage({ message: "Invalid category" })).toBe(
      "Invalid category",
    );
    expect(serverMessage({ message: "" })).toBeUndefined();
    expect(serverMessage("<html>")).toBeUndefined();
    expect(serverMessage(null)).toBeUndefined();
  });

  it("counts Accept all's drafts in photos and by class (fork I42, I50)", () => {
    const suv: Suggestion = { ...JEV, category: "suv" };
    const drafts = [
      { eventId: "a", files: ["a-1", "a-2"], suggestion: JEV },
      { eventId: "b", files: ["b-1"], suggestion: suv },
      { eventId: "c", files: ["c-1"], suggestion: JEV },
    ];
    const tooSmall = { a: ["a-1", "a-2"], b: ["x"] };
    expect(draftImageCount(drafts)).toBe(4);
    expect(tinyImageCount(drafts, tooSmall)).toBe(2);
    expect(tinyImageCount(drafts, undefined)).toBe(0);
    expect(draftsToRun(drafts, tooSmall, false)).toBe(drafts);
    expect(draftsToRun(drafts, tooSmall, true).map((d) => d.eventId)).toEqual([
      "b",
      "c",
    ]);
    expect(draftsPerClass(drafts)).toEqual([
      ["van", 2],
      ["suv", 1],
    ]);
    expect(draftsPerClass(drafts.slice(1))).toEqual([
      ["suv", 1],
      ["van", 1],
    ]);
  });

  it("counts the photos the server answered for", () => {
    const entry: EventSuggestion = {
      text: null,
      jev: null,
      jev_status: "unknown",
      suggestion: null,
      conflict: false,
    };
    const groups = {
      a: [{ filename: "a-1" }, { filename: "a-2" }],
      b: [{ filename: "b-1" }],
    };
    expect(answeredImageCount({ a: entry }, groups)).toEqual({
      answered: 2,
      total: 3,
    });
    expect(answeredImageCount(undefined, groups)).toEqual({
      answered: 0,
      total: 3,
    });
  });
});

describe("modelLabel", () => {
  it("turns a model id into words", () => {
    expect(modelLabel("vehicle_type")).toBe("Vehicle type");
    expect(modelLabel("dog")).toBe("Dog");
  });
});
