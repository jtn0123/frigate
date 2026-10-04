import { afterEach, describe, expect, it, vi } from "vitest";
import type { Polygon } from "@/types/canvas";
import {
  SIDE_A,
  SIDE_B,
  addLinePoint,
  crossingCount,
  directionArrow,
  forkZoneFormValues,
  forkZoneQuery,
  isExclusionPolygon,
  isLineDirection,
  isLineZonePolygon,
  lineEnds,
  lineNormal,
  setZoneShape,
  sideAToBTurn,
  sideLabelPositions,
  sideOfLine,
  startOfDay,
  withLineZoneClicks,
  zoneShapeFields,
} from "./line-zones";

const flags = vi.hoisted(() => ({ lineZones: true }));

vi.mock("@/fork/flags", () => ({
  isForkEnabled: (flag: string) =>
    flag === "lineZones" ? flags.lineZones : true,
}));

afterEach(() => {
  flags.lineZones = true;
});

function zone(extra: Partial<Polygon> = {}): Polygon {
  return {
    typeIndex: 0,
    camera: "street",
    name: "walkway",
    type: "zone",
    objects: [],
    points: [],
    distances: [],
    isFinished: false,
    color: [0, 128, 255],
    ...extra,
  };
}

const PREFIX = "cameras.street.zones.walkway";

describe("sideOfLine", () => {
  // the backend's convention (frigate/fork/line_crossing.py): looking from
  // the first point to the second, with y down, left is A and right is B
  it("puts the left of a left to right line on side A", () => {
    expect(sideOfLine([0, 0], [10, 0], [5, -3])).toBe(SIDE_A);
    expect(sideOfLine([0, 0], [10, 0], [5, 3])).toBe(SIDE_B);
  });

  it("matches the backend for a line drawn down the frame", () => {
    expect(sideOfLine([160, 0], [160, 240], [240, 120])).toBe(SIDE_A);
    expect(sideOfLine([160, 0], [160, 240], [80, 120])).toBe(SIDE_B);
  });

  it("gives no side for a point on the line", () => {
    expect(sideOfLine([0, 0], [10, 10], [5, 5])).toBe(0);
  });
});

describe("lineNormal", () => {
  it("is a unit vector pointing to side B", () => {
    const p1 = [10, 10];
    const p2 = [40, 50];
    const [nx, ny] = lineNormal(p1, p2)!;
    expect(Math.hypot(nx, ny)).toBeCloseTo(1);
    expect(sideOfLine(p1, p2, [25 + nx, 30 + ny])).toBe(SIDE_B);
  });

  it("is undefined for a line of no length", () => {
    expect(lineNormal([3, 3], [3, 3])).toBeUndefined();
  });
});

describe("lineEnds", () => {
  it("returns both ends of a finished line", () => {
    expect(
      lineEnds([
        [1, 2],
        [3, 4],
      ]),
    ).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("is undefined while the line has fewer or more than two points", () => {
    expect(lineEnds([])).toBeUndefined();
    expect(lineEnds([[1, 2]])).toBeUndefined();
    expect(
      lineEnds([
        [1, 2],
        [3, 4],
        [5, 6],
      ]),
    ).toBeUndefined();
  });
});

describe("sideAToBTurn", () => {
  it("turns a right arrow to point from side A to side B", () => {
    // left to right: A above, B below
    expect(
      sideAToBTurn([
        [0, 100],
        [200, 100],
      ]),
    ).toBe(90);
    // drawn down the frame: A on the right, B on the left
    expect(
      sideAToBTurn([
        [160, 0],
        [160, 240],
      ]),
    ).toBe(180);
    // drawn up the frame: A on the left, B on the right
    expect(
      sideAToBTurn([
        [160, 240],
        [160, 0],
      ]),
    ).toBe(0);
    expect(
      sideAToBTurn([
        [0, 0],
        [100, 100],
      ]),
    ).toBe(135);
  });

  it("leaves the arrow alone until the line has both ends", () => {
    expect(sideAToBTurn([])).toBe(0);
    expect(sideAToBTurn([[1, 2]])).toBe(0);
    expect(
      sideAToBTurn([
        [3, 3],
        [3, 3],
      ]),
    ).toBe(0);
  });
});

describe("directionArrow", () => {
  const p1 = [0, 100];
  const p2 = [200, 100];

  it("points from side A to side B for a_to_b", () => {
    const arrow = directionArrow(p1, p2, "a_to_b", 20)!;
    const [x1, y1, x2, y2] = arrow.points;
    expect(arrow.bothWays).toBe(false);
    expect(sideOfLine(p1, p2, [x1, y1])).toBe(SIDE_A);
    expect(sideOfLine(p1, p2, [x2, y2])).toBe(SIDE_B);
    expect([x1, y1, x2, y2]).toEqual([100, 80, 100, 120]);
  });

  it("points from side B to side A for b_to_a", () => {
    const [x1, y1, x2, y2] = directionArrow(p1, p2, "b_to_a", 20)!.points;
    expect(sideOfLine(p1, p2, [x1, y1])).toBe(SIDE_B);
    expect(sideOfLine(p1, p2, [x2, y2])).toBe(SIDE_A);
  });

  it("has heads at both ends for both", () => {
    expect(directionArrow(p1, p2, "both", 20)!.bothWays).toBe(true);
  });

  it("is undefined for a line of no length", () => {
    expect(directionArrow(p1, p1, "both", 20)).toBeUndefined();
  });
});

describe("sideLabelPositions", () => {
  it("puts A and B on their own sides", () => {
    const p1 = [160, 0];
    const p2 = [160, 240];
    const labels = sideLabelPositions(p1, p2, 20)!;
    expect(sideOfLine(p1, p2, labels.a)).toBe(SIDE_A);
    expect(sideOfLine(p1, p2, labels.b)).toBe(SIDE_B);
    expect(labels.a).toEqual([180, 60]);
  });

  it("is undefined for a line of no length", () => {
    expect(sideLabelPositions([1, 1], [1, 1], 20)).toBeUndefined();
  });
});

describe("addLinePoint", () => {
  it("finishes the line on the second click", () => {
    const first = addLinePoint(zone({ zoneType: "line" }), [10, 10], false);
    expect(first.points).toEqual([[10, 10]]);
    expect(first.isFinished).toBe(false);
    const second = addLinePoint(first, [50, 60], false);
    expect(second.points).toEqual([
      [10, 10],
      [50, 60],
    ]);
    expect(second.pointsOrder).toEqual([0, 1]);
    expect(second.isFinished).toBe(true);
  });

  it("ignores clicks once the line has both ends", () => {
    const line = zone({
      zoneType: "line",
      points: [
        [1, 1],
        [2, 2],
      ],
      isFinished: true,
    });
    expect(addLinePoint(line, [5, 5], false)).toBe(line);
  });

  it("ignores a click on an end, which starts a drag", () => {
    const line = zone({ zoneType: "line", points: [[1, 1]] });
    expect(addLinePoint(line, [1, 1], true)).toBe(line);
  });
});

describe("withLineZoneClicks", () => {
  function click(x: number, y: number, onShape?: string) {
    return {
      target: {
        getStage: () => ({
          getPointerPosition: () => ({ x, y }),
          getIntersection: () =>
            onShape === undefined ? null : { getClassName: () => onShape },
        }),
      },
    };
  }

  it("leaves the handler alone for an area or no active zone", () => {
    const handler = vi.fn();
    const setPolygons = vi.fn();
    const polygons = [zone({ zoneType: "polygon" })];
    expect(withLineZoneClicks(handler, polygons, 0, setPolygons)).toBe(handler);
    expect(withLineZoneClicks(handler, polygons, undefined, setPolygons)).toBe(
      handler,
    );
    expect(withLineZoneClicks(handler, polygons, 3, setPolygons)).toBe(handler);
  });

  it("places a line's end instead of a polygon point", () => {
    const handler = vi.fn();
    const setPolygons = vi.fn();
    const area = zone({ name: "yard" });
    const line = zone({ zoneType: "line", points: [[10, 10]] });

    withLineZoneClicks(handler, [area, line], 1, setPolygons)(click(50, 60));

    expect(handler).not.toHaveBeenCalled();
    expect(setPolygons).toHaveBeenCalledWith([
      area,
      expect.objectContaining({
        points: [
          [10, 10],
          [50, 60],
        ],
        isFinished: true,
      }),
    ]);
  });

  it("changes nothing for a click on an end or without a stage", () => {
    const handler = vi.fn();
    const setPolygons = vi.fn();
    const onLine = withLineZoneClicks(
      handler,
      [zone({ zoneType: "line", points: [[10, 10]] })],
      0,
      setPolygons,
    );

    onLine(click(10, 10, "Circle"));
    onLine({ target: { getStage: () => null } });

    expect(handler).not.toHaveBeenCalled();
    expect(setPolygons).not.toHaveBeenCalled();
  });
});

describe("setZoneShape", () => {
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it("starts a line over when the area had more than two points", () => {
    const line = setZoneShape(
      zone({ points: square, isFinished: true, exclusion: true }),
      "line",
    );
    expect(line.zoneType).toBe("line");
    expect(line.points).toEqual([]);
    expect(line.isFinished).toBe(false);
    expect(line.exclusion).toBe(false);
    expect(line.direction).toBe("both");
  });

  it("keeps two points as a finished line", () => {
    const line = setZoneShape(
      zone({
        points: [
          [0, 0],
          [9, 9],
        ],
      }),
      "line",
    );
    expect(line.points).toHaveLength(2);
    expect(line.isFinished).toBe(true);
  });

  it("keeps a line's direction when switching back to a line", () => {
    const line = setZoneShape(zone({ direction: "b_to_a" }), "line");
    expect(line.direction).toBe("b_to_a");
  });

  it("turns a line back into an unfinished area", () => {
    const area = setZoneShape(
      zone({
        zoneType: "line",
        direction: "a_to_b",
        points: [
          [0, 0],
          [9, 9],
        ],
        isFinished: true,
      }),
      "polygon",
    );
    expect(area.zoneType).toBe("polygon");
    expect(area.direction).toBe("both");
    expect(area.isFinished).toBe(false);
  });

  it("keeps a finished area finished", () => {
    const area = setZoneShape(
      zone({ points: square, isFinished: true }),
      "polygon",
    );
    expect(area.isFinished).toBe(true);
  });
});

describe("isLineZonePolygon and isExclusionPolygon", () => {
  it("recognize line and exclusion zones", () => {
    expect(isLineZonePolygon(zone({ zoneType: "line" }))).toBe(true);
    expect(isLineZonePolygon(zone())).toBe(false);
    expect(isLineZonePolygon(null)).toBe(false);
    expect(isExclusionPolygon(zone({ exclusion: true }))).toBe(true);
    expect(isExclusionPolygon(zone())).toBe(false);
    expect(isExclusionPolygon(undefined)).toBe(false);
  });

  it("never treat masks as either", () => {
    const mask = zone({ type: "object_mask", zoneType: "line" });
    expect(isLineZonePolygon(mask)).toBe(false);
    expect(isExclusionPolygon({ ...mask, exclusion: true })).toBe(false);
  });

  it("ignore an exclusion flag left on a line", () => {
    expect(
      isExclusionPolygon(zone({ zoneType: "line", exclusion: true })),
    ).toBe(false);
  });

  it("are off with the flag", () => {
    flags.lineZones = false;
    expect(isLineZonePolygon(zone({ zoneType: "line" }))).toBe(false);
    expect(isExclusionPolygon(zone({ exclusion: true }))).toBe(false);
  });
});

describe("zoneShapeFields", () => {
  it("reads a line zone from the config", () => {
    expect(zoneShapeFields({ type: "line", direction: "a_to_b" })).toEqual({
      zoneType: "line",
      direction: "a_to_b",
      exclusion: false,
    });
  });

  it("defaults zones without the fork fields to areas", () => {
    expect(zoneShapeFields(undefined)).toEqual({
      zoneType: "polygon",
      direction: "both",
      exclusion: false,
    });
    expect(zoneShapeFields({ exclusion: true }).exclusion).toBe(true);
  });

  it("ignores a direction it does not know", () => {
    const fields = zoneShapeFields({
      type: "line",
      direction: "sideways" as never,
    });
    expect(fields.direction).toBe("both");
    expect(isLineDirection("sideways")).toBe(false);
    expect(isLineDirection("b_to_a")).toBe(true);
  });
});

describe("forkZoneQuery", () => {
  const line = zone({ zoneType: "line", direction: "a_to_b" });

  it("saves a line's type and direction", () => {
    expect(forkZoneQuery(PREFIX, line, undefined, false)).toBe(
      `&${PREFIX}.type=line&${PREFIX}.direction=a_to_b`,
    );
  });

  it("drops a saved exclusion when an area becomes a line", () => {
    expect(forkZoneQuery(PREFIX, line, { exclusion: true }, false)).toBe(
      `&${PREFIX}.type=line&${PREFIX}.direction=a_to_b&${PREFIX}.exclusion`,
    );
  });

  it("defaults a line's direction to both", () => {
    expect(
      forkZoneQuery(PREFIX, zone({ zoneType: "line" }), undefined, false),
    ).toBe(`&${PREFIX}.type=line&${PREFIX}.direction=both`);
  });

  it("deletes a line's type and direction when it becomes an area", () => {
    expect(
      forkZoneQuery(
        PREFIX,
        zone({ zoneType: "polygon" }),
        { type: "line", direction: "b_to_a" },
        false,
      ),
    ).toBe(`&${PREFIX}.type&${PREFIX}.direction`);
  });

  it("saves and clears the exclusion flag of an area", () => {
    expect(
      forkZoneQuery(PREFIX, zone({ exclusion: true }), undefined, false),
    ).toBe(`&${PREFIX}.exclusion=True`);
    expect(forkZoneQuery(PREFIX, zone(), { exclusion: true }, false)).toBe(
      `&${PREFIX}.exclusion`,
    );
  });

  it("adds nothing for a plain area", () => {
    expect(forkZoneQuery(PREFIX, zone(), { direction: "both" }, false)).toBe(
      "",
    );
  });

  it("deletes nothing on a renamed zone, which is written fresh", () => {
    expect(
      forkZoneQuery(PREFIX, zone(), { type: "line", exclusion: true }, true),
    ).toBe("");
  });

  it("adds nothing with the flag off", () => {
    flags.lineZones = false;
    expect(forkZoneQuery(PREFIX, line, { exclusion: true }, false)).toBe("");
  });
});

describe("forkZoneFormValues", () => {
  const values = { loitering_time: 5, speedEstimation: true, name: "a" };

  it("clears loitering and speed on a line", () => {
    expect(forkZoneFormValues(values, zone({ zoneType: "line" }))).toEqual({
      loitering_time: 0,
      speedEstimation: false,
      name: "a",
    });
  });

  it("leaves an area's values alone", () => {
    expect(forkZoneFormValues(values, zone())).toBe(values);
    expect(forkZoneFormValues(values, undefined)).toBe(values);
  });
});

describe("crossing counts", () => {
  it("starts the day at the browser's midnight without a UI time zone", () => {
    const now = new Date(2026, 9, 2, 15, 30, 12);
    const midnight = new Date(2026, 9, 2, 0, 0, 0).getTime() / 1000;
    expect(startOfDay(now)).toBe(midnight);
    expect(startOfDay(now, null)).toBe(midnight);
  });

  it("starts the day at midnight in the UI's time zone", () => {
    // 20:00 UTC on Oct 2 is already 05:00 on Oct 3 in Tokyo
    const now = Date.UTC(2026, 9, 2, 20, 0, 0);
    expect(startOfDay(now, "Asia/Tokyo")).toBe(
      Date.UTC(2026, 9, 2, 15, 0, 0) / 1000,
    );
    // and still 13:00 on Oct 2 in Los Angeles
    expect(startOfDay(now, "America/Los_Angeles")).toBe(
      Date.UTC(2026, 9, 2, 7, 0, 0) / 1000,
    );
  });

  it("reads a fixed UTC offset as the UI stores it", () => {
    const now = Date.UTC(2026, 9, 2, 20, 0, 0);
    expect(startOfDay(now, "UTC+05:00")).toBe(
      Date.UTC(2026, 9, 2, 19, 0, 0) / 1000,
    );
    expect(startOfDay(now, "UTC-03:30")).toBe(
      Date.UTC(2026, 9, 2, 3, 30, 0) / 1000,
    );
  });

  it("uses the offset in force at midnight on a daylight saving day", () => {
    // New York moves its clocks back at 02:00 on Nov 1 2026, so that day's
    // midnight is still on daylight time (UTC-4)
    const now = Date.UTC(2026, 10, 1, 20, 0, 0);
    expect(startOfDay(now, "America/New_York")).toBe(
      Date.UTC(2026, 10, 1, 4, 0, 0) / 1000,
    );
  });

  it("finds one line's count", () => {
    const walkway = {
      camera: "street",
      zone: "walkway",
      direction: "a_to_b",
      total: 4,
      labels: { person: 4 },
    };
    const data = {
      after: 0,
      before: 1,
      lines: [{ ...walkway, camera: "yard" }, walkway],
    };
    expect(crossingCount(data, "street", "walkway")).toBe(walkway);
    expect(crossingCount(data, "street", "gate")).toBeUndefined();
    expect(crossingCount(undefined, "street", "walkway")).toBeUndefined();
  });
});
