import { describe, expect, it } from "vitest";
import { timelineKeyValue } from "./timelineKeys";

describe("timeline range navigation", () => {
  it("keeps page steps inside the available range", () => {
    expect(timelineKeyValue("PageUp", 180, 100, 200, 10)).toBe(200);
    expect(timelineKeyValue("PageDown", 120, 100, 200, 10)).toBe(100);
  });
  it("leaves unrelated keys alone and handles a range with one value", () => {
    expect(timelineKeyValue("Tab", 150, 100, 200, 10)).toBeUndefined();
    expect(timelineKeyValue("ArrowLeft", 100, 100, 100, 10)).toBe(100);
    expect(timelineKeyValue("End", 100, 100, 100, 10)).toBe(100);
  });
});
