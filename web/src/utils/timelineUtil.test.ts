import { describe, expect, it } from "vitest";
import { getVisibleTimestampBounds } from "./timelineUtil";

describe("visible timestamp bounds", () => {
  it("compares numeric timestamps across digit boundaries without mutation", () => {
    const timestamps = ["100", "9.5", "20"];
    expect(getVisibleTimestampBounds(timestamps)).toEqual({
      start: 9.5,
      end: 100,
    });
    expect(timestamps).toEqual(["100", "9.5", "20"]);
  });

  it("handles empty and invalid observer timestamps", () => {
    expect(getVisibleTimestampBounds([])).toEqual({ start: 0, end: 0 });
    expect(getVisibleTimestampBounds(["invalid", "Infinity"])).toEqual({
      start: 0,
      end: 0,
    });
    expect(getVisibleTimestampBounds(["invalid", "10"])).toEqual({
      start: 10,
      end: 10,
    });
  });
});
