import { describe, expect, it } from "vitest";
import { readSavedGrid } from "./live-layout";

describe("readSavedGrid", () => {
  it("reads a pre-#24461 bare array on 16:9 rows", () => {
    expect(
      readSavedGrid([{ i: "front", x: 0, y: 0, w: 4, h: 4, moved: false }]),
    ).toEqual({
      items: [{ i: "front", x: 0, y: 0, w: 4, h: 4 }],
      rowUnit: 9 / 16,
    });
  });

  it("reads a versioned layout on quarter-column rows", () => {
    expect(
      readSavedGrid({
        version: 2,
        naturalAspect: true,
        layout: [{ i: "front", x: 0, y: 0, w: 32, h: 72 }],
      }),
    ).toEqual({
      items: [{ i: "front", x: 0, y: 0, w: 32, h: 72 }],
      rowUnit: 1 / 4,
    });
  });

  it("rejects unknown versions and malformed items", () => {
    expect(readSavedGrid({ version: 3, layout: [] })).toBeUndefined();
    expect(readSavedGrid([{ i: "front", x: "0" }])).toBeUndefined();
    expect(readSavedGrid(undefined)).toBeUndefined();
    expect(readSavedGrid("layout")).toBeUndefined();
  });
});
