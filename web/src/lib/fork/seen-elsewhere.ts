/**
 * "Seen on other cameras" for the tracked object detail (fork UI145).
 *
 * Frigate does no cross-camera re-identification, but a recognized face (the
 * sub label) or license plate already names the same person or car on every
 * camera, and `/events` filters by both plus camera and time. These helpers
 * build those queries for the other cameras around the object's time, the
 * optional CLIP similarity query, and turn the answers into sightings and
 * one timeline lane per camera. Pure functions, so they are unit tested.
 */

import { fromZonedTime, toZonedTime } from "date-fns-tz";
import type { EventType, SearchResult } from "@/types/search";

export const SEEN_WINDOWS = ["15m", "30m", "1h", "6h", "day"] as const;
export type SeenWindow = (typeof SEEN_WINDOWS)[number];
export const DEFAULT_SEEN_WINDOW: SeenWindow = "30m";

/** localStorage key that remembers the last window picked. */
export const SEEN_WINDOW_STORAGE_KEY = "frigateFork.seenElsewhereWindow";

const WINDOW_SECONDS: Record<Exclude<SeenWindow, "day">, number> = {
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
};

/**
 * Rows asked for per identity on each side of the object. Each side asks
 * for the sightings nearest the object first, so a busy window leaves out
 * the farthest ones and the panel says so.
 */
export const IDENTITY_SIDE_LIMIT = 50;
/** How often a panel open on an object still in view looks again. */
export const LIVE_REFRESH_MS = 60_000;
/** Appearance matches shown; past this they stop being useful. */
export const SIMILAR_LIMIT = 8;
/** The narrowest span the timeline strip draws, so dots do not pile up. */
export const MIN_AXIS_SECONDS = 10 * 60;

export function isSeenWindow(value: unknown): value is SeenWindow {
  return (
    typeof value === "string" &&
    (SEEN_WINDOWS as readonly string[]).includes(value)
  );
}

export type TimeWindow = { after: number; before: number };

/** `ui.timezone` may be an IANA name or "UTC+05:00"; date-fns-tz wants "+05:00". */
function zoneFor(timezone?: string | null): string {
  if (!timezone) {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  const offset = /^UTC([+-]\d{2}:\d{2})$/.exec(timezone);
  return offset?.[1] ?? timezone;
}

/** Midnight to midnight of the day `timestamp` falls on, in `timezone`. */
export function dayWindow(
  timestamp: number,
  timezone?: string | null,
): TimeWindow {
  const zone = zoneFor(timezone);
  const local = toZonedTime(timestamp * 1000, zone);
  local.setHours(0, 0, 0, 0);
  const after = fromZonedTime(local, zone).getTime() / 1000;
  local.setDate(local.getDate() + 1);
  const before = fromZonedTime(local, zone).getTime() / 1000;
  return { after, before };
}

/**
 * The span searched around an object. `pivot` splits it into the sightings
 * before the object and the ones from its start on. `live` marks an object
 * still in view: its window ends at now, so the end keeps moving.
 */
export type SeenRange = TimeWindow & { pivot: number; live: boolean };

/**
 * The span searched for sightings: the object's time plus or minus the
 * window. An object still in view has no end yet, so it lasts until `now`,
 * which is where the question "where is it now" points.
 */
export function seenWindow(
  choice: SeenWindow,
  start: number,
  end: number | null | undefined,
  now: number,
  timezone?: string | null,
): SeenRange {
  const live = end == null;
  const last = end ?? Math.max(now, start);
  const pivot = Math.floor(start);
  if (choice === "day") {
    // every day it was in view, which is one day for nearly every object
    return {
      after: dayWindow(start, timezone).after,
      before: dayWindow(last, timezone).before,
      pivot,
      live,
    };
  }
  const span = WINDOW_SECONDS[choice];
  return {
    after: Math.floor(start - span),
    before: Math.ceil(last + span),
    pivot,
    live,
  };
}

export type SeenIdentity = {
  kind: "name" | "plate";
  /** What the panel shows. */
  value: string;
  /** What the API filter gets. */
  param: string;
};

// `/events` reads a plate holding any of these as a regular expression.
const PLATE_REGEX_TRIGGER = /[.[\]?+*]/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * The `recognized_license_plate` filter value that matches exactly this
 * plate. Plain plates go as they are; one the API would read as a pattern is
 * escaped and anchored, so "AB.123" does not also match "ABX123".
 */
export function plateParam(plate: string): string {
  if (!plate.startsWith("^") && !PLATE_REGEX_TRIGGER.test(plate)) {
    return plate;
  }
  return `^${plate.replace(REGEX_SPECIAL, String.raw`\$&`)}$`;
}

/** The face or name (sub label) and plate this object can be followed by. */
export function seenIdentities(
  subLabel?: string | null,
  recognizedPlate?: string | null,
): SeenIdentity[] {
  const identities: SeenIdentity[] = [];
  const names = (subLabel ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length > 0) {
    identities.push({
      kind: "name",
      value: names.join(", "),
      param: names.join(","),
    });
  }

  const plate = recognizedPlate?.trim();
  // the filter splits on commas, so a plate holding one cannot be asked for
  if (plate && !plate.includes(",")) {
    identities.push({ kind: "plate", value: plate, param: plateParam(plate) });
  }
  return identities;
}

/** Every camera but the object's own, sorted so the query key is stable. */
export function otherCameras(cameras: string[], current: string): string[] {
  return cameras.filter((camera) => camera !== current).sort();
}

export type QueryParams = Record<string, string | number>;

/** The two reads per identity: before the object, and from its start on. */
export const SEEN_SIDES = ["earlier", "later"] as const;
export type SeenSide = (typeof SEEN_SIDES)[number];

/**
 * `/events` parameters for one identity on the other cameras, on one side
 * of the object. Each side is sorted nearest first, so when a side holds
 * more than the limit the cut drops the sightings farthest from the object.
 */
export function identityParams(
  identity: SeenIdentity,
  range: SeenRange,
  cameras: string[],
  side: SeenSide,
): QueryParams {
  const common = {
    cameras: cameras.join(","),
    [identity.kind === "name" ? "sub_labels" : "recognized_license_plate"]:
      identity.param,
    limit: IDENTITY_SIDE_LIMIT,
    include_thumbnails: 0,
  };
  // the bounds are exclusive, so the sides overlap by a second around the
  // pivot: a sighting that began with the object is in one or both, merged
  if (side === "earlier") {
    return {
      ...common,
      after: range.after,
      before: range.pivot + 1,
      sort: "date_desc",
    };
  }
  if (range.live) {
    // everything since its start overlaps it, and the newest say where it
    // is now; no upper bound keeps the key, and so the cache, steady while
    // the refresh looks again
    return { ...common, after: range.pivot, sort: "date_desc" };
  }
  return {
    ...common,
    after: range.pivot,
    before: range.before,
    sort: "date_asc",
  };
}

/** Both sides of one identity as one list, each sighting once. */
export function mergeSides(
  earlier: SearchResult[] | undefined,
  later: SearchResult[] | undefined,
): SearchResult[] | undefined {
  if (!earlier && !later) {
    return undefined;
  }
  const byId = new Map<string, SearchResult>();
  for (const event of [...(earlier ?? []), ...(later ?? [])]) {
    if (!byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()];
}

/** Whether a side came back full, so farther sightings were left out. */
export function sideFull(answer: SearchResult[] | undefined): boolean {
  return (answer?.length ?? 0) >= IDENTITY_SIDE_LIMIT;
}

/** `/events/search` parameters for CLIP look-alikes on the other cameras. */
export function similarParams(
  eventId: string,
  label: string,
  range: SeenRange,
  cameras: string[],
): QueryParams {
  return {
    search_type: "similarity",
    event_id: eventId,
    cameras: cameras.join(","),
    labels: label,
    after: range.after,
    // open ended while the object is in view, as with the later identity side
    ...(range.live ? {} : { before: range.before }),
    limit: SIMILAR_LIMIT,
    include_thumbnails: 0,
  };
}

/** The setting that would let the panel find an object it cannot follow. */
export type SeenSetup = "face" | "plate" | "similar";

type SetupInput = {
  label: string;
  type: EventType;
  /** The detector's model reads license plates on this label. */
  plateLabel: boolean;
  faceRecognition: boolean;
  plateRecognition: boolean;
  semanticSearch: boolean;
};

/**
 * For an object the panel has nothing to look for, which feature would
 * change that: face recognition for a person, plate recognition for a
 * vehicle, otherwise semantic search (offered alongside the first two).
 * Nothing for audio and manual events, which no feature here can follow.
 */
export function seenSetup(object: SetupInput): SeenSetup | undefined {
  if (object.type === "audio" || object.type === "manual") {
    return undefined;
  }
  if (object.semanticSearch) {
    return undefined;
  }
  if (object.label === "person" && !object.faceRecognition) {
    return "face";
  }
  if (object.plateLabel && !object.plateRecognition) {
    return "plate";
  }
  return "similar";
}

export type SightingReason = "name" | "plate" | "similar";

export type Sighting = {
  event: SearchResult;
  reasons: SightingReason[];
  /** 0 to 1, only on appearance matches. */
  similarity?: number | undefined;
  /** Seconds from the current object's start; negative is earlier. */
  offset: number;
};

export type SeenMatches = {
  name?: SearchResult[] | undefined;
  plate?: SearchResult[] | undefined;
  similar?: SearchResult[] | undefined;
};

type CurrentObject = {
  id: string;
  camera: string;
  start_time: number;
  end_time?: number | undefined;
};

/** Cosine distance from the similarity search as a 0 to 1 likeness. */
export function similarityOf(event: {
  // typed as always present, but only the similarity search sends it
  search_distance?: number | undefined;
}): number | undefined {
  const distance = event.search_distance;
  if (typeof distance !== "number" || !Number.isFinite(distance)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, 1 - distance));
}

/**
 * Merge the answers into sightings on other cameras. A sighting found by
 * name and by plate is one sighting with both reasons; one the identity
 * queries found is never repeated as a mere look-alike. Matched sightings
 * read in time order, look-alikes by how alike they are.
 */
export function buildSightings(
  current: CurrentObject,
  matches: SeenMatches,
): { matched: Sighting[]; similar: Sighting[] } {
  const elsewhere = (event: SearchResult | undefined): event is SearchResult =>
    !!event && event.id !== current.id && event.camera !== current.camera;

  const byId = new Map<string, Sighting>();
  const identityLists = [
    ["name", matches.name],
    ["plate", matches.plate],
  ] as const;
  for (const [reason, list] of identityLists) {
    for (const event of (list ?? []).filter(elsewhere)) {
      const known = byId.get(event.id);
      if (known) {
        if (!known.reasons.includes(reason)) {
          known.reasons.push(reason);
        }
        continue;
      }
      byId.set(event.id, {
        event,
        reasons: [reason],
        offset: event.start_time - current.start_time,
      });
    }
  }
  const matched = [...byId.values()].sort(
    (a, b) => a.event.start_time - b.event.start_time,
  );

  const similar: Sighting[] = [];
  const taken = new Set(byId.keys());
  for (const event of (matches.similar ?? []).filter(elsewhere)) {
    if (taken.has(event.id)) {
      continue;
    }
    taken.add(event.id);
    similar.push({
      event,
      reasons: ["similar"],
      similarity: similarityOf(event),
      offset: event.start_time - current.start_time,
    });
  }
  similar.sort(
    (a, b) =>
      (b.similarity ?? 0) - (a.similarity ?? 0) ||
      a.event.start_time - b.event.start_time,
  );

  return { matched, similar };
}

export type LaneMark = {
  id: string;
  start: number;
  end: number;
  kind: "current" | "matched" | "similar";
  sighting?: Sighting;
};

export type CameraLane = {
  camera: string;
  current: boolean;
  /** Earliest mark, which orders the lanes into the path taken. */
  first: number;
  marks: LaneMark[];
};

/**
 * One lane per camera holding its marks, the object's own camera included,
 * ordered by each camera's first sighting so the lanes read top to bottom
 * as the route taken. `now` stands in for the end of anything in progress.
 */
export function cameraLanes(
  current: CurrentObject,
  matched: Sighting[],
  similar: Sighting[],
  now: number,
): CameraLane[] {
  const lanes = new Map<string, CameraLane>();
  const add = (camera: string, mark: LaneMark) => {
    const lane = lanes.get(camera) ?? {
      camera,
      current: camera === current.camera,
      first: mark.start,
      marks: [],
    };
    lane.marks.push(mark);
    lane.first = Math.min(lane.first, mark.start);
    lanes.set(camera, lane);
  };

  add(current.camera, {
    id: current.id,
    start: current.start_time,
    end: current.end_time ?? Math.max(now, current.start_time),
    kind: "current",
  });
  const sightingMark = (
    sighting: Sighting,
    kind: "matched" | "similar",
  ): LaneMark => ({
    id: sighting.event.id,
    start: sighting.event.start_time,
    end: sighting.event.end_time ?? Math.max(now, sighting.event.start_time),
    kind,
    sighting,
  });
  for (const sighting of matched) {
    add(sighting.event.camera, sightingMark(sighting, "matched"));
  }
  for (const sighting of similar) {
    add(sighting.event.camera, sightingMark(sighting, "similar"));
  }

  const result = [...lanes.values()];
  for (const lane of result) {
    lane.marks.sort((a, b) => a.start - b.start);
  }
  return result.sort(
    (a, b) =>
      a.first - b.first ||
      Number(b.current) - Number(a.current) ||
      a.camera.localeCompare(b.camera),
  );
}

export type AxisRange = { start: number; end: number };

/**
 * The span the strip draws: every mark plus a little room, at least
 * `MIN_AXIS_SECONDS` wide, and never past the window that was searched.
 */
export function axisRange(lanes: CameraLane[], range: TimeWindow): AxisRange {
  const marks = lanes.flatMap((lane) => lane.marks);
  if (marks.length === 0) {
    return { start: range.after, end: range.before };
  }
  let start = Math.min(...marks.map((mark) => mark.start));
  let end = Math.max(...marks.map((mark) => mark.end));
  const pad = Math.max((end - start) * 0.08, 60);
  start -= pad;
  end += pad;
  if (end - start < MIN_AXIS_SECONDS) {
    const middle = (start + end) / 2;
    start = middle - MIN_AXIS_SECONDS / 2;
    end = middle + MIN_AXIS_SECONDS / 2;
  }
  start = Math.max(start, range.after);
  end = Math.min(end, range.before);
  return end > start
    ? { start, end }
    : { start: range.after, end: range.before };
}

/** Where `time` sits on the axis, as a 0 to 100 percentage. */
export function axisPercent(time: number, axis: AxisRange): number {
  const span = axis.end - axis.start;
  if (span <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, ((time - axis.start) / span) * 100));
}

export type Gap = {
  direction: "earlier" | "later" | "same";
  hours: number;
  minutes: number;
};

/** An offset in seconds as whole hours and minutes, rounded to the minute. */
export function gapOf(offset: number): Gap {
  const total = Math.round(Math.abs(offset) / 60);
  if (total === 0) {
    return { direction: "same", hours: 0, minutes: 0 };
  }
  return {
    direction: offset < 0 ? "earlier" : "later",
    hours: Math.floor(total / 60),
    minutes: total % 60,
  };
}

/** Explore's history key for the open detail (see SearchView). */
export const EXPLORE_SELECTED_KEY = "exploreSelectedId";

/**
 * Where a sighting opens: Explore filtered to that one object, with its
 * detail already open. Explore keeps the open object in history state, so
 * passing it there opens the dialog once the single result loads.
 */
export function sightingLink(id: string): {
  to: string;
  state: Record<string, string>;
} {
  return {
    to: `/explore?event_id=${encodeURIComponent(id)}`,
    state: { [EXPLORE_SELECTED_KEY]: id },
  };
}
