import { describe, expect, it } from "vitest";
import type { SearchResult } from "@/types/search";
import {
  DEFAULT_SEEN_WINDOW,
  EXPLORE_SELECTED_KEY,
  IDENTITY_SIDE_LIMIT,
  MIN_AXIS_SECONDS,
  SIMILAR_LIMIT,
  axisPercent,
  axisRange,
  buildSightings,
  cameraLanes,
  dayWindow,
  gapOf,
  identityParams,
  isSeenWindow,
  mergeSides,
  otherCameras,
  plateParam,
  seenIdentities,
  seenSetup,
  seenWindow,
  sideFull,
  sightingLink,
  similarParams,
  similarityOf,
  type QueryParams,
  type SeenIdentity,
} from "./seen-elsewhere";

// 2026-06-05 10:00:00 UTC
const T = 1780653600;

function event(
  id: string,
  camera: string,
  start: number,
  extra: Partial<SearchResult> = {},
): SearchResult {
  return {
    id,
    camera,
    start_time: start,
    end_time: start + 30,
    label: "person",
    score: 0.9,
    has_snapshot: true,
    has_clip: true,
    zones: [],
    search_source: "thumbnail",
    search_distance: 0,
    top_score: 0.9,
    data: {
      top_score: 0.9,
      score: 0.9,
      region: [],
      box: [],
      area: 0,
      ratio: 1,
      type: "object",
      average_estimated_speed: 0,
      velocity_angle: 0,
      path_data: [],
    },
    ...extra,
  };
}

const CURRENT = event("cur", "front_door", T);

describe("windows", () => {
  it("knows its window names and defaults to half an hour", () => {
    expect(DEFAULT_SEEN_WINDOW).toBe("30m");
    expect(isSeenWindow("6h")).toBe(true);
    expect(isSeenWindow("2h")).toBe(false);
    expect(isSeenWindow(undefined)).toBe(false);
    expect(isSeenWindow(30)).toBe(false);
  });

  it.each([
    ["15m", 15 * 60],
    ["30m", 30 * 60],
    ["1h", 3600],
    ["6h", 6 * 3600],
  ] as const)("pads %s on both sides of the object", (choice, span) => {
    expect(seenWindow(choice, T, T + 45, T + 9999)).toEqual({
      after: T - span,
      before: T + 45 + span,
      pivot: T,
      live: false,
    });
  });

  it("runs an object still in view up to now", () => {
    // in view for 12 hours: the window reaches past now, not just its start
    const now = T + 12 * 3600;
    expect(seenWindow("15m", T, undefined, now)).toEqual({
      after: T - 900,
      before: now + 900,
      pivot: T,
      live: true,
    });
    expect(seenWindow("1h", T, null, now)).toEqual({
      after: T - 3600,
      before: now + 3600,
      pivot: T,
      live: true,
    });
    // a clock behind the start still covers the start
    expect(seenWindow("15m", T, undefined, T - 30).before).toBe(T + 900);
  });

  it("covers every day an object in view has spanned", () => {
    // 10:00 UTC on June 5, still in view at 02:00 UTC on June 6
    expect(seenWindow("day", T, undefined, T + 16 * 3600, "UTC")).toEqual({
      after: Date.UTC(2026, 5, 5) / 1000,
      before: Date.UTC(2026, 5, 7) / 1000,
      pivot: T,
      live: true,
    });
  });

  it("rounds fractional times outward so the object stays inside", () => {
    expect(seenWindow("15m", T + 0.6, T + 10.2, T + 60)).toEqual({
      after: T - 900,
      before: T + 911,
      pivot: T,
      live: false,
    });
  });

  it("spans the calendar day in the configured time zone", () => {
    // 10:00 UTC is 03:00 in Los Angeles (PDT, UTC-7) on June 5
    expect(dayWindow(T, "America/Los_Angeles")).toEqual({
      after: Date.UTC(2026, 5, 5, 7) / 1000,
      before: Date.UTC(2026, 5, 6, 7) / 1000,
    });
    expect(seenWindow("day", T, T + 30, T + 60, "UTC")).toEqual({
      after: Date.UTC(2026, 5, 5) / 1000,
      before: Date.UTC(2026, 5, 6) / 1000,
      pivot: T,
      live: false,
    });
  });

  it("reads a UTC offset zone", () => {
    // 10:00 UTC is 15:00 at UTC+05:00, so the day began at 19:00 UTC the day before
    expect(dayWindow(T, "UTC+05:00")).toEqual({
      after: Date.UTC(2026, 5, 4, 19) / 1000,
      before: Date.UTC(2026, 5, 5, 19) / 1000,
    });
  });

  it("follows a daylight saving change, so that day is 23 hours", () => {
    // March 8, 2026: Los Angeles springs forward
    const noon = Date.UTC(2026, 2, 8, 20) / 1000;
    const day = dayWindow(noon, "America/Los_Angeles");
    expect(day.after).toBe(Date.UTC(2026, 2, 8, 8) / 1000);
    expect(day.before - day.after).toBe(23 * 3600);
  });
});

describe("identities", () => {
  it("follows a face by its sub label", () => {
    expect(seenIdentities("Alice", undefined)).toEqual([
      { kind: "name", value: "Alice", param: "Alice" },
    ]);
  });

  it("follows a car by its plate", () => {
    expect(seenIdentities(null, " 8ABC123 ")).toEqual([
      { kind: "plate", value: "8ABC123", param: "8ABC123" },
    ]);
  });

  it("uses both when a known plate also named the car", () => {
    expect(seenIdentities("Bob's Tesla", "7XYZ890").map((i) => i.kind)).toEqual(
      ["name", "plate"],
    );
  });

  it("splits a joined sub label into a clean filter list", () => {
    expect(seenIdentities("Alice, Bob", undefined)).toEqual([
      { kind: "name", value: "Alice, Bob", param: "Alice,Bob" },
    ]);
  });

  it("has nothing to follow without a name or plate", () => {
    expect(seenIdentities(undefined, undefined)).toEqual([]);
    expect(seenIdentities("  ", "")).toEqual([]);
  });

  it("skips a plate the comma separated filter could not carry", () => {
    expect(seenIdentities(undefined, "AB,12")).toEqual([]);
  });

  it("sends plain plates as they are and anchors ones that look like patterns", () => {
    expect(plateParam("8ABC123")).toBe("8ABC123");
    expect(plateParam("AB-123")).toBe("AB-123");
    expect(plateParam("AB.123")).toBe(String.raw`^AB\.123$`);
    expect(plateParam("^X1")).toBe(String.raw`^\^X1$`);
    expect(plateParam("A+B*")).toBe(String.raw`^A\+B\*$`);
  });
});

describe("query parameters", () => {
  const range = { after: T - 1800, before: T + 1830, pivot: T, live: false };
  const alice: SeenIdentity = { kind: "name", value: "Alice", param: "Alice" };

  it("lists the other cameras, sorted for a stable key", () => {
    expect(
      otherCameras(["garage", "front_door", "driveway"], "front_door"),
    ).toEqual(["driveway", "garage"]);
    expect(otherCameras(["front_door"], "front_door")).toEqual([]);
  });

  it("asks /events for the same name before the object, newest first", () => {
    expect(
      identityParams(alice, range, ["backyard", "driveway"], "earlier"),
    ).toEqual({
      cameras: "backyard,driveway",
      sub_labels: "Alice",
      after: range.after,
      // the bounds are exclusive: a second past the pivot keeps a sighting
      // that began with the object
      before: T + 1,
      sort: "date_desc",
      limit: IDENTITY_SIDE_LIMIT,
      include_thumbnails: 0,
    });
  });

  it("asks /events for the same name from the object on, oldest first", () => {
    expect(identityParams(alice, range, ["backyard"], "later")).toEqual({
      cameras: "backyard",
      sub_labels: "Alice",
      after: T,
      before: range.before,
      sort: "date_asc",
      limit: IDENTITY_SIDE_LIMIT,
      include_thumbnails: 0,
    });
  });

  it("leaves the end open and asks for the newest while it is in view", () => {
    const live = seenWindow("30m", T, undefined, T + 600);
    const later = identityParams(alice, live, ["backyard"], "later");
    expect(later).toMatchObject({ after: T, sort: "date_desc" });
    expect(later).not.toHaveProperty("before");
    // the read's key does not move with the clock, so it refreshes in place
    expect(
      identityParams(
        alice,
        seenWindow("30m", T, undefined, T + 660),
        ["backyard"],
        "later",
      ),
    ).toEqual(later);
    // the earlier side does not depend on now at all
    expect(identityParams(alice, live, ["backyard"], "earlier")).toEqual(
      identityParams(
        alice,
        seenWindow("30m", T, undefined, T + 9000),
        ["backyard"],
        "earlier",
      ),
    );
  });

  it("asks /events for the same plate on the other cameras", () => {
    const params = identityParams(
      { kind: "plate", value: "8ABC123", param: "8ABC123" },
      range,
      ["street"],
      "later",
    );
    expect(params).toMatchObject({
      recognized_license_plate: "8ABC123",
      cameras: "street",
    });
    expect(params).not.toHaveProperty("sub_labels");
  });

  it("asks the similarity search for the same label on the other cameras", () => {
    expect(similarParams("cur", "person", range, ["garage"])).toEqual({
      search_type: "similarity",
      event_id: "cur",
      cameras: "garage",
      labels: "person",
      after: range.after,
      before: range.before,
      limit: SIMILAR_LIMIT,
      include_thumbnails: 0,
    });
    const live = { ...range, live: true };
    expect(similarParams("cur", "person", live, ["garage"])).not.toHaveProperty(
      "before",
    );
  });
});

/**
 * The part of `/events` the identity reads rely on: an exclusive time
 * range, a date sort and a limit.
 */
function serve(events: SearchResult[], params: QueryParams): SearchResult[] {
  const { after, before, sort, limit } = params as {
    after?: number;
    before?: number;
    sort: string;
    limit: number;
  };
  const found = events.filter(
    (e) =>
      (after === undefined || e.start_time > after) &&
      (before === undefined || e.start_time < before),
  );
  found.sort((a, b) =>
    sort === "date_asc"
      ? a.start_time - b.start_time
      : b.start_time - a.start_time,
  );
  return found.slice(0, limit);
}

describe("closest sightings first", () => {
  const alice: SeenIdentity = { kind: "name", value: "Alice", param: "Alice" };
  // a resident seen every 10 seconds from 2 hours before to 2 hours after
  const busy = Array.from({ length: 1441 }, (_, i) =>
    event(`a${i}`, "garage", T - 7200 + i * 10),
  );

  function read(range: ReturnType<typeof seenWindow>) {
    const earlier = serve(
      busy,
      identityParams(alice, range, ["garage"], "earlier"),
    );
    const later = serve(
      busy,
      identityParams(alice, range, ["garage"], "later"),
    );
    return { earlier, later, merged: mergeSides(earlier, later) ?? [] };
  }

  it("keeps the sightings nearest the object on both sides of it", () => {
    const { earlier, later, merged } = read(seenWindow("6h", T, T + 30, T));
    expect(merged).toHaveLength(2 * IDENTITY_SIDE_LIMIT);
    const starts = merged.map((e) => e.start_time - T);
    // the 50 up to its start and the 50 after it, not the first 100 of the
    // window, which all came about 2 hours before
    expect(Math.min(...starts)).toBe(-490);
    expect(Math.max(...starts)).toBe(500);
    expect(sideFull(earlier)).toBe(true);
    expect(sideFull(later)).toBe(true);
  });

  it("keeps the newest sightings while the object is still in view", () => {
    const { later } = read(seenWindow("1h", T, undefined, T + 7200));
    expect(later[0]?.start_time).toBe(T + 7200);
    expect(later.at(-1)?.start_time).toBe(T + 7200 - 490);
  });

  it("is not full when a side holds fewer than the limit", () => {
    const quiet = busy.slice(0, 10);
    expect(sideFull(quiet)).toBe(false);
    expect(sideFull(undefined)).toBe(false);
  });

  it("merges the sides once each, and has nothing before either answers", () => {
    const a = event("a", "garage", T);
    const b = event("b", "garage", T + 5);
    expect(mergeSides([a], [a, b])?.map((e) => e.id)).toEqual(["a", "b"]);
    expect(mergeSides(undefined, [b])?.map((e) => e.id)).toEqual(["b"]);
    expect(mergeSides(undefined, undefined)).toBeUndefined();
  });
});

describe("setup hint", () => {
  const off = {
    type: "object" as const,
    plateLabel: false,
    faceRecognition: false,
    plateRecognition: false,
    semanticSearch: false,
  };

  it("names face recognition for a person", () => {
    expect(seenSetup({ ...off, label: "person" })).toBe("face");
  });

  it("names plate recognition for a vehicle that carries a plate", () => {
    expect(seenSetup({ ...off, label: "car", plateLabel: true })).toBe("plate");
  });

  it("names semantic search when the matching recognition is already on", () => {
    expect(seenSetup({ ...off, label: "person", faceRecognition: true })).toBe(
      "similar",
    );
    expect(
      seenSetup({
        ...off,
        label: "car",
        plateLabel: true,
        plateRecognition: true,
      }),
    ).toBe("similar");
    expect(seenSetup({ ...off, label: "dog" })).toBe("similar");
  });

  it("says nothing when semantic search is on or nothing could help", () => {
    expect(
      seenSetup({ ...off, label: "person", semanticSearch: true }),
    ).toBeUndefined();
    expect(
      seenSetup({ ...off, label: "speech", type: "audio" }),
    ).toBeUndefined();
    expect(
      seenSetup({ ...off, label: "person", type: "manual" }),
    ).toBeUndefined();
  });
});

describe("sightings", () => {
  it("turns a cosine distance into a 0 to 1 likeness", () => {
    expect(similarityOf({ search_distance: 0.18 })).toBeCloseTo(0.82);
    expect(similarityOf({ search_distance: 1.4 })).toBe(0);
    expect(similarityOf({ search_distance: -0.1 })).toBe(1);
    expect(similarityOf({ search_distance: Number.NaN })).toBeUndefined();
    expect(similarityOf({})).toBeUndefined();
  });

  it("keeps only other cameras and orders matches by time", () => {
    const backyard = event("b", "backyard", T + 600);
    const driveway = event("d", "driveway", T + 180);
    const sameCamera = event("f2", "front_door", T + 60);
    const { matched, similar } = buildSightings(CURRENT, {
      name: [backyard, CURRENT, sameCamera, driveway],
    });
    expect(matched.map((s) => s.event.id)).toEqual(["d", "b"]);
    expect(matched.map((s) => s.offset)).toEqual([180, 600]);
    expect(matched[0]?.reasons).toEqual(["name"]);
    expect(similar).toEqual([]);
  });

  it("merges a sighting found by name and by plate", () => {
    const street = event("s", "street", T - 240);
    const { matched } = buildSightings(CURRENT, {
      name: [street],
      plate: [street, event("g", "garage", T + 30)],
    });
    expect(matched.map((s) => [s.event.id, s.reasons])).toEqual([
      ["s", ["name", "plate"]],
      ["g", ["plate"]],
    ]);
  });

  it("never repeats a matched sighting as a look-alike", () => {
    const driveway = event("d", "driveway", T + 180, { search_distance: 0.1 });
    const garage = event("g", "garage", T + 400, { search_distance: 0.3 });
    const garage2 = event("g2", "garage", T - 400, { search_distance: 0.3 });
    const yard = event("y", "backyard", T + 50, { search_distance: 0.2 });
    const { matched, similar } = buildSightings(CURRENT, {
      name: [driveway],
      similar: [garage, driveway, yard, garage2, garage],
    });
    expect(matched.map((s) => s.event.id)).toEqual(["d"]);
    // most alike first, ties broken by time
    expect(similar.map((s) => s.event.id)).toEqual(["y", "g2", "g"]);
    expect(similar[0]?.similarity).toBeCloseTo(0.8);
    expect(similar[0]?.reasons).toEqual(["similar"]);
  });

  it("copes with no answers yet", () => {
    expect(buildSightings(CURRENT, {})).toEqual({ matched: [], similar: [] });
  });
});

describe("camera lanes", () => {
  it("orders lanes by each camera's first sighting, the route taken", () => {
    const { matched, similar } = buildSightings(CURRENT, {
      name: [
        event("b", "backyard", T + 600),
        event("d", "driveway", T + 180),
        event("d2", "driveway", T + 900),
      ],
      similar: [event("g", "garage", T - 300, { search_distance: 0.2 })],
    });
    const lanes = cameraLanes(CURRENT, matched, similar, T + 5000);
    expect(lanes.map((lane) => lane.camera)).toEqual([
      "garage",
      "front_door",
      "driveway",
      "backyard",
    ]);
    expect(lanes[1]?.current).toBe(true);
    expect(lanes[1]?.marks.map((m) => m.kind)).toEqual(["current"]);
    expect(lanes[0]?.marks.map((m) => m.kind)).toEqual(["similar"]);
    expect(lanes[2]?.marks.map((m) => m.id)).toEqual(["d", "d2"]);
    expect(lanes[2]?.first).toBe(T + 180);
  });

  it("puts the object's own camera first on a tie", () => {
    const { matched } = buildSightings(CURRENT, {
      name: [event("a", "alley", T)],
    });
    const lanes = cameraLanes(CURRENT, matched, [], T);
    expect(lanes.map((lane) => lane.camera)).toEqual(["front_door", "alley"]);
  });

  it("draws anything in progress up to now", () => {
    const { end_time: _ended, ...live } = event("cur", "front_door", T);
    const lanes = cameraLanes(live, [], [], T + 120);
    expect(lanes[0]?.marks[0]?.end).toBe(T + 120);
    // a clock behind the start never draws a negative bar
    expect(cameraLanes(live, [], [], T - 50)[0]?.marks[0]?.end).toBe(T);
  });
});

describe("axis", () => {
  const range = { after: T - 3600, before: T + 3630 };

  it("fits the marks with some room", () => {
    const { matched } = buildSightings(CURRENT, {
      name: [event("b", "backyard", T + 1800)],
    });
    const lanes = cameraLanes(CURRENT, matched, [], T);
    const axis = axisRange(lanes, range);
    const pad = 1830 * 0.08;
    expect(axis.start).toBeCloseTo(T - pad);
    expect(axis.end).toBeCloseTo(T + 1830 + pad);
  });

  it("is never narrower than the minimum span", () => {
    const lanes = cameraLanes(CURRENT, [], [], T);
    const axis = axisRange(lanes, range);
    expect(axis.end - axis.start).toBeCloseTo(MIN_AXIS_SECONDS);
    expect((axis.start + axis.end) / 2).toBeCloseTo(T + 15);
  });

  it("stays inside the searched window", () => {
    const tight = { after: T - 60, before: T + 90 };
    const lanes = cameraLanes(CURRENT, [], [], T);
    expect(axisRange(lanes, tight)).toEqual({ start: T - 60, end: T + 90 });
  });

  it("falls back to the window without marks", () => {
    expect(axisRange([], range)).toEqual({
      start: range.after,
      end: range.before,
    });
  });

  it("places times as clamped percentages", () => {
    const axis = { start: 100, end: 300 };
    expect(axisPercent(200, axis)).toBe(50);
    expect(axisPercent(0, axis)).toBe(0);
    expect(axisPercent(400, axis)).toBe(100);
    expect(axisPercent(150, { start: 100, end: 100 })).toBe(0);
  });
});

describe("gaps", () => {
  it.each([
    [0, { direction: "same", hours: 0, minutes: 0 }],
    [25, { direction: "same", hours: 0, minutes: 0 }],
    [-29, { direction: "same", hours: 0, minutes: 0 }],
    [180, { direction: "later", hours: 0, minutes: 3 }],
    [-240, { direction: "earlier", hours: 0, minutes: 4 }],
    [3600, { direction: "later", hours: 1, minutes: 0 }],
    [
      -(2 * 3600 + 15 * 60 + 20),
      { direction: "earlier", hours: 2, minutes: 15 },
    ],
  ] as const)("reads an offset of %i seconds", (offset, gap) => {
    expect(gapOf(offset)).toEqual(gap);
  });
});

describe("opening a sighting", () => {
  it("opens Explore on that one object with its detail open", () => {
    expect(sightingLink("1780.5-abc")).toEqual({
      to: "/explore?event_id=1780.5-abc",
      state: { [EXPLORE_SELECTED_KEY]: "1780.5-abc" },
    });
    expect(sightingLink("a b&c").to).toBe("/explore?event_id=a%20b%26c");
  });
});
