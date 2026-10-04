/**
 * Fork (D75, D76, D77): line zones, their crossing direction, and exclusion
 * zones in the zone editor.
 *
 * A line zone is two points that objects cross. Looking from the first point
 * to the second, side A is on the left and side B on the right; the backend
 * (`frigate/fork/line_crossing.py`) uses the same sign of the cross product,
 * so the A and B labels drawn here are the sides the direction setting means.
 * An exclusion zone is a polygon whose objects are tracked but never alert.
 */

import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { isForkEnabled } from "@/fork/flags";
import type { Polygon } from "@/types/canvas";
import type { components } from "@/types/fork/api.gen";

export type ZoneShape = "polygon" | "line";
export type LineDirection = "both" | "a_to_b" | "b_to_a";

export const LINE_DIRECTIONS: readonly LineDirection[] = [
  "both",
  "a_to_b",
  "b_to_a",
];

export const SIDE_A = -1;
export const SIDE_B = 1;

/** The zone settings this fork adds, as the config stores them. */
export type ZoneShapeConfig = {
  type?: ZoneShape;
  direction?: LineDirection;
  exclusion?: boolean;
};

type Point = readonly number[];

export function isLineDirection(value: unknown): value is LineDirection {
  return LINE_DIRECTIONS.includes(value as LineDirection);
}

/** Whether the editor treats a polygon as a two point line zone. */
export function isLineZonePolygon(
  polygon: Polygon | null | undefined,
): boolean {
  return (
    !!polygon &&
    polygon.type === "zone" &&
    polygon.zoneType === "line" &&
    isForkEnabled("lineZones")
  );
}

/** Whether the editor draws a polygon as an exclusion zone. */
export function isExclusionPolygon(
  polygon: Polygon | null | undefined,
): boolean {
  return (
    !!polygon &&
    polygon.type === "zone" &&
    polygon.zoneType !== "line" &&
    !!polygon.exclusion &&
    isForkEnabled("lineZones")
  );
}

/** The fork fields of a polygon built from a zone's config. */
export function zoneShapeFields(zone: ZoneShapeConfig | undefined) {
  return {
    zoneType: zone?.type === "line" ? "line" : "polygon",
    direction: isLineDirection(zone?.direction) ? zone.direction : "both",
    exclusion: !!zone?.exclusion,
  } satisfies Pick<Polygon, "zoneType" | "direction" | "exclusion">;
}

/** A point's x and y; editor points are plain arrays, so a gap reads as 0. */
function xy(point: Point): [number, number] {
  return [point[0] ?? 0, point[1] ?? 0];
}

/**
 * Which side of the line from `p1` to `p2` a point is on: SIDE_A (left,
 * looking from p1 to p2 with y pointing down), SIDE_B (right), or 0 on it.
 */
export function sideOfLine(p1: Point, p2: Point, point: Point): number {
  const [x1, y1] = xy(p1);
  const [x2, y2] = xy(p2);
  const [x, y] = xy(point);
  const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
  if (cross < 0) return SIDE_A;
  if (cross > 0) return SIDE_B;
  return 0;
}

/** The unit normal of the line, pointing to side B, or undefined if p1 is p2. */
export function lineNormal(p1: Point, p2: Point): [number, number] | undefined {
  const [x1, y1] = xy(p1);
  const [x2, y2] = xy(p2);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) return undefined;
  return [-dy / length, dx / length];
}

/** The point `fraction` of the way from p1 to p2. */
function along(p1: Point, p2: Point, fraction: number): [number, number] {
  const [x1, y1] = xy(p1);
  const [x2, y2] = xy(p2);
  return [x1 + (x2 - x1) * fraction, y1 + (y2 - y1) * fraction];
}

/** A line's two ends once both are placed, or undefined while it is drawn. */
export function lineEnds(points: readonly Point[]): [Point, Point] | undefined {
  if (points.length !== 2) return undefined;
  return [points[0] ?? [0, 0], points[1] ?? [0, 0]];
}

/**
 * How far to turn a left to right arrow, in degrees clockwise on screen, so it
 * points from side A to side B as the arrow on the line does; 0 until both
 * ends are placed.
 */
export function sideAToBTurn(points: readonly Point[]): number {
  const ends = lineEnds(points);
  const normal = ends && lineNormal(...ends);
  if (!normal) return 0;
  // + 0 turns -0 into 0
  return Math.round((Math.atan2(normal[1], normal[0]) * 180) / Math.PI) + 0;
}

/** The arrow across the middle of a line, pointing the way it counts. */
export type DirectionArrow = {
  /** Start and end, `[x1, y1, x2, y2]`; the head is at the end. */
  points: [number, number, number, number];
  /** Heads at both ends, for a line that counts either way. */
  bothWays: boolean;
};

export function directionArrow(
  p1: Point,
  p2: Point,
  direction: LineDirection,
  halfLength: number,
): DirectionArrow | undefined {
  const normal = lineNormal(p1, p2);
  if (!normal) return undefined;
  const [mx, my] = along(p1, p2, 0.5);
  // from side A to side B unless the line only counts B to A
  const sign = direction === "b_to_a" ? -1 : 1;
  const dx = normal[0] * halfLength * sign;
  const dy = normal[1] * halfLength * sign;
  return {
    points: [mx - dx, my - dy, mx + dx, my + dy],
    bothWays: direction === "both",
  };
}

/** Where the A and B labels go: beside the line, one on each side. */
export function sideLabelPositions(
  p1: Point,
  p2: Point,
  offset: number,
): { a: [number, number]; b: [number, number] } | undefined {
  const normal = lineNormal(p1, p2);
  if (!normal) return undefined;
  // a quarter of the way along, so the labels clear the arrow in the middle
  const [x, y] = along(p1, p2, 0.25);
  const [nx, ny] = normal;
  return {
    a: [x - nx * offset, y - ny * offset],
    b: [x + nx * offset, y + ny * offset],
  };
}

/**
 * A click on the canvas while a line zone is active: the first two clicks
 * place its ends and finish it, and clicks after that (or on an end, which
 * starts a drag) change nothing.
 */
export function addLinePoint(
  polygon: Polygon,
  point: number[],
  onPoint: boolean,
): Polygon {
  if (onPoint || polygon.points.length >= 2) return polygon;
  const points = [...polygon.points, point];
  return {
    ...polygon,
    points,
    pointsOrder: points.map((_, index) => index),
    isFinished: points.length === 2,
  };
}

type CanvasPoint = { x: number; y: number };

/** The parts of a Konva pointer event that a line zone click reads. */
export type LineZoneClickEvent = {
  target: {
    getStage(): {
      getPointerPosition(): CanvasPoint | null;
      getIntersection(pos: CanvasPoint): { getClassName(): string } | null;
    } | null;
  };
};

/**
 * Wrap the zone canvas's click handler for line zones. While a line zone is
 * active, a click goes to addLinePoint and never reaches the polygon
 * handler, which would add, remove or close polygon points. Any other active
 * shape gets the handler unchanged.
 */
export function withLineZoneClicks<E extends LineZoneClickEvent>(
  handler: (e: E) => void,
  polygons: Polygon[],
  activePolygonIndex: number | undefined,
  setPolygons: (polygons: Polygon[]) => void,
): (e: E) => void {
  const active =
    activePolygonIndex === undefined ? undefined : polygons[activePolygonIndex];
  if (
    activePolygonIndex === undefined ||
    active === undefined ||
    !isLineZonePolygon(active)
  ) {
    return handler;
  }

  return (e) => {
    const stage = e.target.getStage();
    if (stage === null) return;
    const pos = stage.getPointerPosition() ?? { x: 0, y: 0 };
    const onPoint = stage.getIntersection(pos)?.getClassName() === "Circle";
    const line = addLinePoint(active, [pos.x, pos.y], onPoint);
    if (line !== active) {
      const updated = [...polygons];
      updated[activePolygonIndex] = line;
      setPolygons(updated);
    }
  };
}

/**
 * Switch the zone being edited between an area and a line. A drawing that
 * does not fit the new shape starts over; two points already make a line.
 */
export function setZoneShape(polygon: Polygon, shape: ZoneShape): Polygon {
  if (shape === "line") {
    const keep = polygon.points.length <= 2;
    const points = keep ? polygon.points : [];
    return {
      ...polygon,
      zoneType: "line",
      direction: polygon.direction ?? "both",
      exclusion: false,
      points,
      pointsOrder: points.map((_, index) => index),
      isFinished: points.length === 2,
    };
  }
  return {
    ...polygon,
    zoneType: "polygon",
    direction: "both",
    isFinished: polygon.isFinished && polygon.points.length >= 3,
  };
}

/** Query parameters a zone gets from a line or exclusion zone. */
export function forkZoneQuery(
  pathPrefix: string,
  polygon: Polygon,
  existing: ZoneShapeConfig | undefined,
  renaming: boolean,
): string {
  if (!isForkEnabled("lineZones")) return "";
  // a renamed zone is written fresh, so there is nothing to delete
  const saved = renaming ? undefined : existing;
  const parts: string[] = [];

  if (polygon.zoneType === "line") {
    parts.push(`type=line`, `direction=${polygon.direction ?? "both"}`);
    if (saved?.exclusion) parts.push("exclusion");
  } else {
    if (saved?.type === "line") parts.push("type");
    if (saved?.direction && saved.direction !== "both") {
      parts.push("direction");
    }
    if (polygon.exclusion) parts.push("exclusion=True");
    else if (saved?.exclusion) parts.push("exclusion");
  }

  return parts.map((part) => `&${pathPrefix}.${part}`).join("");
}

/** Form values a line zone saves: it has no loitering or speed settings. */
export function forkZoneFormValues<
  T extends { loitering_time: number; speedEstimation: boolean },
>(values: T, polygon: Polygon | null | undefined): T {
  if (!isLineZonePolygon(polygon)) return values;
  return { ...values, loitering_time: 0, speedEstimation: false };
}

/** `ui.timezone` may be an IANA name or "UTC+05:00"; date-fns-tz wants "+05:00". */
function timeZoneFor(timezone?: string | null): string {
  if (!timezone) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = /^UTC([+-]\d{2}:\d{2})$/.exec(timezone);
  return offset?.[1] ?? timezone;
}

/**
 * Midnight at the start of the day `now` falls on in `timezone` (the UI's
 * `ui.timezone`, or the browser's when it is unset), as a Unix timestamp.
 */
export function startOfDay(
  now: Date | number,
  timezone?: string | null,
): number {
  const zone = timeZoneFor(timezone);
  const local = toZonedTime(now, zone);
  local.setHours(0, 0, 0, 0);
  return Math.floor(fromZonedTime(local, zone).getTime() / 1000);
}

export type LineCrossingCount = components["schemas"]["LineCrossingCount"];
export type LineCrossingsResponse =
  components["schemas"]["LineCrossingsResponse"];

/** The count for one line, or undefined while it loads or is not a line. */
export function crossingCount(
  data: LineCrossingsResponse | undefined,
  camera: string,
  zone: string,
): LineCrossingCount | undefined {
  return data?.lines.find(
    (line) => line.camera === camera && line.zone === zone,
  );
}
