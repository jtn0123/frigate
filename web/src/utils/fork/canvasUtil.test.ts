import { describe, expect, it } from "vitest";
import type { Polygon } from "@/types/canvas";
import {
  dragBoundFunc,
  flattenPoints,
  getAveragePoint,
  getDistance,
  interpolatePoints,
  masksAreIdentical,
  minMax,
  parseCoordinates,
  snapPointToLines,
  toRGBColorString,
} from "@/utils/canvasUtil";

function polygon(points: number[][], isFinished = true): Polygon {
  return {
    typeIndex: 0,
    camera: "front",
    name: "zone_1",
    type: "zone",
    objects: [],
    points,
    distances: [],
    isFinished,
    color: [0, 0, 255],
  };
}

describe("getAveragePoint", () => {
  it("averages the x and y halves of a flat point list", () => {
    expect(getAveragePoint([0, 0, 10, 0, 10, 20, 0, 20])).toEqual({
      x: 5,
      y: 10,
    });
  });
});

describe("getDistance", () => {
  it("returns the euclidean distance with two decimals", () => {
    expect(getDistance([0, 0], [3, 4])).toBe("5.00");
    expect(getDistance([5, 5], [4, 4])).toBe("1.41");
  });
});

describe("dragBoundFunc", () => {
  it("keeps a point that is inside the stage", () => {
    expect(dragBoundFunc(100, 50, 5, { x: 40, y: 20 })).toEqual({
      x: 40,
      y: 20,
    });
  });

  it("clamps to the far edges when the vertex would overflow", () => {
    expect(dragBoundFunc(100, 50, 5, { x: 98, y: 47 })).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("clamps to zero when the vertex would underflow", () => {
    expect(dragBoundFunc(100, 50, 5, { x: 2, y: 3 })).toEqual({ x: 0, y: 0 });
  });
});

describe("minMax", () => {
  it("returns the smallest and largest value", () => {
    expect(minMax([4, -2, 9, 0])).toEqual([-2, 9]);
  });

  it("returns undefined bounds for an empty list", () => {
    expect(minMax([])).toEqual([undefined, undefined]);
  });
});

describe("interpolatePoints", () => {
  it("scales points to the new size and caps them at the bounds", () => {
    expect(
      interpolatePoints(
        [
          [10, 20],
          [100, 50],
          [1, 1],
        ],
        100,
        50,
        200,
        100,
      ),
    ).toEqual([
      [20, 40],
      [200, 100],
      [2, 2],
    ]);
  });

  it("rounds to three decimals", () => {
    expect(interpolatePoints([[1, 1]], 3, 3, 1, 1)).toEqual([[0.333, 0.333]]);
  });
});

describe("parseCoordinates and flattenPoints", () => {
  it("round-trips a coordinate string", () => {
    const points = parseCoordinates("0.1,0.2,0.3,0.4");
    expect(points).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(flattenPoints(points)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("yields NaN for a dangling coordinate", () => {
    expect(parseCoordinates("1,2,3")).toEqual([
      [1, 2],
      [3, NaN],
    ]);
  });
});

describe("toRGBColorString", () => {
  it("swaps BGR to RGB and picks the alpha from the darkened flag", () => {
    expect(toRGBColorString([10, 20, 30], false)).toBe("rgba(30,20,10,0.3)");
    expect(toRGBColorString([10, 20, 30], true)).toBe("rgba(30,20,10,0.7)");
  });

  it("falls back to translucent red for malformed colors", () => {
    expect(toRGBColorString([1, 2], true)).toBe("rgb(220,0,0,0.5)");
  });
});

describe("masksAreIdentical", () => {
  it("compares length and order", () => {
    expect(masksAreIdentical(["a", "b"], ["a", "b"])).toBe(true);
    expect(masksAreIdentical(["a", "b"], ["b", "a"])).toBe(false);
    expect(masksAreIdentical(["a"], ["a", "b"])).toBe(false);
    expect(masksAreIdentical([], [])).toBe(true);
  });
});

describe("snapPointToLines", () => {
  const square = polygon([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]);

  it("projects a nearby point onto the closest edge", () => {
    expect(snapPointToLines([5, 1], [square], 2)).toEqual([5, 0]);
  });

  it("snaps to the segment start when the projection falls before it", () => {
    expect(snapPointToLines([-1, -1], [square], 2)).toEqual([0, 0]);
  });

  it("snaps to the segment end when the projection falls past it", () => {
    const line = polygon([
      [0, 0],
      [10, 0],
    ]);
    // the closing edge runs back from [10, 0] to [0, 0], so beyond either
    // end the closest point is the endpoint itself
    expect(snapPointToLines([11, 1], [line], 2)).toEqual([10, 0]);
  });

  it("handles zero-length edges", () => {
    const dot = polygon([
      [3, 3],
      [3, 3],
    ]);
    expect(snapPointToLines([4, 3], [dot], 2)).toEqual([3, 3]);
  });

  it("returns null when nothing is within the threshold", () => {
    expect(snapPointToLines([5, 5], [square], 2)).toBeNull();
  });

  it("ignores unfinished polygons", () => {
    expect(snapPointToLines([5, 1], [polygon(square.points, false)], 2)).toBe(
      null,
    );
  });
});
