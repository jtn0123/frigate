import { describe, expect, it } from "vitest";
import {
  allOnEdge,
  boxAtTime,
  isEdgePoint,
  type TimedBox,
} from "./track-overlay";

// Box is [left, top, width, height]; path points are ground points
// (bottom-center of the box), all normalized 0-1.
const boxes: TimedBox[] = [
  { timestamp: 100, box: [0.1, 0.2, 0.1, 0.3] },
  { timestamp: 105, box: [0.6, 0.2, 0.2, 0.4] },
];

describe("boxAtTime", () => {
  it("returns the recorded box at a recorded moment", () => {
    expect(boxAtTime(boxes, [], 100.005)).toEqual([0.1, 0.2, 0.1, 0.3]);
  });

  it("places the box on the path between two close points", () => {
    const path = [
      { timestamp: 101, x: 0.2, y: 0.5 },
      { timestamp: 102, x: 0.4, y: 0.7 },
    ];
    // halfway: ground (0.3, 0.6), size from the nearest box (t=100)
    const box = boxAtTime(boxes, path, 101.5)!;
    expect(box[0]).toBeCloseTo(0.25);
    expect(box[1]).toBeCloseTo(0.3);
    expect(box[2]).toBeCloseTo(0.1);
    expect(box[3]).toBeCloseTo(0.3);
  });

  it("shows no box when the path points are too far apart", () => {
    const path = [
      { timestamp: 100, x: 0.15, y: 0.5 },
      { timestamp: 105, x: 0.7, y: 0.6 },
    ];
    expect(boxAtTime(boxes, path, 102.5)).toBeUndefined();
  });

  it("uses a lone path point only when it is close in time", () => {
    const path = [{ timestamp: 103, x: 0.5, y: 0.8 }];
    const near = boxAtTime(boxes, path, 103.2)!;
    expect(near[0]).toBeCloseTo(0.4);
    expect(near[1]).toBeCloseTo(0.4);
    expect(boxAtTime(boxes, path, 103.6)).toBeUndefined();
  });

  it("shows no box for an object with no recorded boxes", () => {
    expect(
      boxAtTime([], [{ timestamp: 1, x: 0.5, y: 0.5 }], 1),
    ).toBeUndefined();
  });
});

describe("edge points", () => {
  it("flags ground points on the bottom edge", () => {
    expect(isEdgePoint(1)).toBe(true);
    expect(isEdgePoint(0.98)).toBe(true);
    expect(isEdgePoint(0.9)).toBe(false);
  });

  it("detects a path pinned entirely to the edge", () => {
    expect(allOnEdge([{ y: 1 }, { y: 0.99 }])).toBe(true);
    expect(allOnEdge([{ y: 1 }, { y: 0.6 }])).toBe(false);
    expect(allOnEdge([])).toBe(false);
  });
});
