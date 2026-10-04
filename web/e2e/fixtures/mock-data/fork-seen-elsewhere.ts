/**
 * Tracked objects and a filtering `/api/events` for "Seen on other cameras"
 * (UI145).
 *
 * The default events route answers every query with the same list. This
 * one applies the filters the panel and the Explore grid send (cameras,
 * labels, sub labels, plates, time, id, sort, limit), so a spec can check
 * that the right sightings come back, and answers the similarity search from
 * a fixed list of look-alikes with their distances.
 */

import type { Page, Request } from "@playwright/test";

export type MockTrackedObject = {
  id: string;
  label: string;
  sub_label: string | null;
  camera: string;
  start_time: number;
  end_time: number | null;
  false_positive: boolean;
  zones: string[];
  thumbnail: null;
  has_clip: boolean;
  has_snapshot: boolean;
  retain_indefinitely: boolean;
  plus_id: null;
  model_hash: string;
  detector_type: string;
  model_type: string;
  data: Record<string, unknown>;
  search_distance?: number;
};

type TrackedObjectExtra = {
  subLabel?: string;
  plate?: string;
  duration?: number;
  zones?: string[];
  description?: string;
};

export function trackedObject(
  id: string,
  camera: string,
  label: string,
  start: number,
  extra: TrackedObjectExtra = {},
): MockTrackedObject {
  const duration = extra.duration ?? 25;
  return {
    id,
    label,
    sub_label: extra.subLabel ?? null,
    camera,
    start_time: start,
    end_time: start + duration,
    false_positive: false,
    zones: extra.zones ?? [],
    thumbnail: null,
    has_clip: true,
    has_snapshot: true,
    retain_indefinitely: false,
    plus_id: null,
    model_hash: "abc123",
    detector_type: "cpu",
    model_type: "ssd",
    data: {
      top_score: 0.91,
      score: 0.89,
      region: [0.1, 0.1, 0.5, 0.8],
      box: [0.3, 0.2, 0.42, 0.75],
      area: 0.06,
      ratio: 0.5,
      type: "object",
      description: extra.description ?? "",
      average_estimated_speed: 0,
      velocity_angle: 0,
      path_data: [],
      ...(extra.subLabel ? { sub_label_score: 0.93 } : {}),
      ...(extra.plate
        ? {
            recognized_license_plate: extra.plate,
            recognized_license_plate_score: 0.95,
          }
        : {}),
    },
  };
}

function listParam(params: URLSearchParams, key: string): string[] | null {
  const value = params.get(key);
  return value && value !== "all" ? value.split(",") : null;
}

/** The subset of `/api/events` filtering the panel and Explore rely on. */
export function filterEvents(
  events: MockTrackedObject[],
  params: URLSearchParams,
): MockTrackedObject[] {
  const cameras = listParam(params, "cameras");
  const labels = listParam(params, "labels");
  const subLabels = listParam(params, "sub_labels")?.map((s) =>
    s.toLowerCase(),
  );
  const plates = listParam(params, "recognized_license_plate");
  const after = params.get("after");
  const before = params.get("before");
  const eventId = params.get("event_id");

  const matches = events.filter((event) => {
    const plate = event.data.recognized_license_plate;
    return (
      (!cameras || cameras.includes(event.camera)) &&
      (!labels || labels.includes(event.label)) &&
      (!subLabels ||
        (event.sub_label !== null &&
          subLabels.includes(event.sub_label.toLowerCase()))) &&
      (!plates || (typeof plate === "string" && plates.includes(plate))) &&
      (after === null || event.start_time > Number(after)) &&
      (before === null || event.start_time < Number(before)) &&
      (eventId === null || event.id === eventId)
    );
  });

  matches.sort((a, b) =>
    params.get("sort") === "date_asc"
      ? a.start_time - b.start_time
      : b.start_time - a.start_time,
  );
  const limit = Number(params.get("limit") ?? 100);
  return matches.slice(0, limit);
}

export type SeenElsewhereRoutes = {
  /** Every `/api/events` list request, as URLSearchParams. */
  events: URLSearchParams[];
  /** Every similarity request. */
  similar: URLSearchParams[];
};

type RouteOptions = {
  /** Look-alikes the similarity search returns, best first. */
  similar?: MockTrackedObject[];
  /** Holds a panel query (one that names a sub label or plate) until it resolves. */
  holdIdentity?: Promise<void>;
  /** Answers panel queries with a server error. */
  failIdentity?: boolean;
};

function isPanelQuery(params: URLSearchParams): boolean {
  return (
    params.get("sub_labels") !== null ||
    params.get("recognized_license_plate") !== null
  );
}

/**
 * Route `/api/events` and `/api/events/search` through the filters above.
 * Register after `installDefaults` so these routes win.
 */
export async function installSeenElsewhereRoutes(
  page: Page,
  events: MockTrackedObject[],
  options: RouteOptions = {},
): Promise<SeenElsewhereRoutes> {
  const log: SeenElsewhereRoutes = { events: [], similar: [] };
  const paramsOf = (request: Request) => new URL(request.url()).searchParams;

  await page.route(/\/api\/events(\?|$)/, async (route) => {
    const params = paramsOf(route.request());
    log.events.push(params);
    if (isPanelQuery(params)) {
      if (options.failIdentity) {
        return route.fulfill({ status: 500, json: { success: false } });
      }
      await options.holdIdentity;
    }
    return route.fulfill({ json: filterEvents(events, params) });
  });

  await page.route(/\/api\/events\/search(\?|$)/, (route) => {
    const params = paramsOf(route.request());
    if (params.get("search_type") === "similarity") {
      log.similar.push(params);
      // event_id names the object to compare with, not a result filter
      const filters = new URLSearchParams(params);
      filters.delete("event_id");
      const found = filterEvents(options.similar ?? [], filters);
      // relevance order: the closest first
      found.sort((a, b) => (a.search_distance ?? 0) - (b.search_distance ?? 0));
      return route.fulfill({ json: found });
    }
    return route.fulfill({ json: [] });
  });

  return log;
}
