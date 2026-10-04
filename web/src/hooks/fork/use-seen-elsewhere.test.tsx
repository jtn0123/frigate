import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY_SIDE_LIMIT,
  LIVE_REFRESH_MS,
} from "@/lib/fork/seen-elsewhere";
import type { SearchResult } from "@/types/search";
import { useSeenElsewhere } from "./use-seen-elsewhere";

vi.mock("@/hooks/use-allowed-cameras", () => ({
  useAllowedCameras: () => ["front_door", "garage", "backyard"],
}));

// 2026-06-05 10:00:00 UTC
const T = 1780653600;

/** The identity read parameters these tests look at. */
type Params = {
  cameras: string;
  sub_labels?: string;
  after?: number;
  before?: number;
  sort: string;
  limit: number;
};
type Key = string | [string, Params];

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

function config(overrides: { face?: boolean; semantic?: boolean } = {}) {
  return {
    ui: { timezone: "UTC" },
    semantic_search: { enabled: overrides.semantic ?? false },
    face_recognition: { enabled: overrides.face ?? false },
    lpr: { enabled: false },
    cameras: {},
    models: [{ attributes_map: { car: ["license_plate"] } }],
  };
}

/** `/events` as the identity reads use it: exclusive bounds, sort, limit. */
function serve(events: SearchResult[], params: Params): SearchResult[] {
  const cameras = params.cameras.split(",");
  const found = events.filter(
    (e) =>
      cameras.includes(e.camera) &&
      e.sub_label === params.sub_labels &&
      (params.after === undefined || e.start_time > params.after) &&
      (params.before === undefined || e.start_time < params.before),
  );
  found.sort((a, b) =>
    params.sort === "date_asc"
      ? a.start_time - b.start_time
      : b.start_time - a.start_time,
  );
  return found.slice(0, params.limit);
}

type Server = {
  config: ReturnType<typeof config>;
  sightings: SearchResult[];
  /** The open object's own row, read while it is in view. */
  own?: SearchResult;
  reads: Params[];
};

function wrapper(server: Server) {
  const cache = new Map();
  const fetcher = (key: Key) => {
    if (key === "config") {
      return Promise.resolve(server.config);
    }
    if (typeof key === "string") {
      return Promise.resolve(server.own);
    }
    const [, params] = key;
    server.reads.push(params);
    return Promise.resolve(serve(server.sightings, params));
  };
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return (
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
          shouldRetryOnError: false,
          fetcher,
        }}
      >
        {children}
      </SWRConfig>
    );
  };
}

/** Lets the reads settle under fake timers. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useSeenElsewhere", () => {
  it("follows an object still in view up to now, and looks again each minute until it ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((T + 3600) * 1000);
    const { end_time: _ended, ...base } = event("cur", "front_door", T, {
      sub_label: "Alice",
    });
    const search = base as SearchResult;
    const server: Server = {
      config: config({ face: true }),
      // 50 min after it started, while it is still in view: outside a
      // window measured from its start alone
      sightings: [event("g", "garage", T + 3000, { sub_label: "Alice" })],
      own: search,
      reads: [],
    };
    const { result } = renderHook(() => useSeenElsewhere(search, "30m"), {
      wrapper: wrapper(server),
    });
    await settle();
    await settle();

    expect(result.current.range).toMatchObject({
      after: T - 1800,
      before: T + 3600 + 1800,
      live: true,
    });
    expect(result.current.matched.map((s) => s.event.id)).toEqual(["g"]);
    const later = server.reads.filter((p) => p.after === T);
    expect(later).toHaveLength(1);
    expect(later[0]).not.toHaveProperty("before");
    expect(later[0]?.sort).toBe("date_desc");

    // a minute on, the same reads run again and the window follows the clock
    server.sightings.push(
      event("b", "backyard", T + 3630, { sub_label: "Alice" }),
    );
    await settle(LIVE_REFRESH_MS);
    await settle();
    expect(server.reads.filter((p) => p.after === T).length).toBeGreaterThan(1);
    expect(result.current.now).toBe(T + 3600 + 60);
    expect(result.current.range.before).toBe(T + 3660 + 1800);
    expect(result.current.matched.map((s) => s.event.id)).toEqual(["g", "b"]);
    // a background refresh, not a new window: nothing dims
    expect(result.current.refreshing).toBe(false);

    // it ends: the window closes on its end and the refreshing stops
    server.own = { ...search, end_time: T + 3700 };
    await settle(LIVE_REFRESH_MS);
    await settle();
    await settle();
    expect(result.current.range).toMatchObject({
      before: T + 3700 + 1800,
      live: false,
    });
    expect(result.current.current.end_time).toBe(T + 3700);
    const closed = server.reads.at(-1);
    expect(closed).toMatchObject({
      after: T,
      before: T + 3700 + 1800,
      sort: "date_asc",
    });
    const count = server.reads.length;
    await settle(5 * LIVE_REFRESH_MS);
    expect(server.reads).toHaveLength(count);
  });

  it("does not refresh a finished object", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((T + 3600) * 1000);
    const search = event("cur", "front_door", T, { sub_label: "Alice" });
    const server: Server = { config: config(), sightings: [], reads: [] };
    renderHook(() => useSeenElsewhere(search, "30m"), {
      wrapper: wrapper(server),
    });
    await settle();
    await settle();
    expect(server.reads).toHaveLength(2);
    expect(server.reads.every((p) => p.before !== undefined)).toBe(true);
    await settle(5 * LIVE_REFRESH_MS);
    expect(server.reads).toHaveLength(2);
  });

  it("keeps the sightings nearest the object and says a side came back full", async () => {
    const search = event("cur", "front_door", T, { sub_label: "Alice" });
    // seen every 10 seconds from 2 hours before to 2 hours after
    const busy = Array.from({ length: 1441 }, (_, i) =>
      event(`a${i}`, "garage", T - 7200 + i * 10, { sub_label: "Alice" }),
    );
    const server: Server = { config: config(), sightings: busy, reads: [] };
    const { result } = renderHook(() => useSeenElsewhere(search, "6h"), {
      wrapper: wrapper(server),
    });

    await waitFor(() =>
      expect(result.current.matched).toHaveLength(2 * IDENTITY_SIDE_LIMIT),
    );
    const offsets = result.current.matched.map((s) => s.offset);
    // the closest either side of the object, in time order
    expect(offsets[0]).toBe(-490);
    expect(offsets.at(-1)).toBe(500);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(result.current.capped).toBe(true);
  });

  it("is not capped when every sighting fits", async () => {
    const search = event("cur", "front_door", T, { sub_label: "Alice" });
    const server: Server = {
      config: config(),
      sightings: [
        event("g", "garage", T - 300, { sub_label: "Alice" }),
        event("b", "backyard", T + 300, { sub_label: "Alice" }),
      ],
      reads: [],
    };
    const { result } = renderHook(() => useSeenElsewhere(search, "30m"), {
      wrapper: wrapper(server),
    });

    await waitFor(() => expect(result.current.matched).toHaveLength(2));
    expect(result.current.capped).toBe(false);
  });

  it("names the setting that would give it something to follow", async () => {
    const stranger = event("cur", "front_door", T);
    const server: Server = { config: config(), sightings: [], reads: [] };
    const { result } = renderHook(() => useSeenElsewhere(stranger, "30m"), {
      wrapper: wrapper(server),
    });
    await waitFor(() => expect(result.current.config).toBeDefined());
    expect(result.current.active).toBe(false);
    expect(result.current.setup).toBe("face");

    const car = event("car", "front_door", T, { label: "car" });
    const plates = renderHook(() => useSeenElsewhere(car, "30m"), {
      wrapper: wrapper({ ...server, config: config({ face: true }) }),
    });
    await waitFor(() => expect(plates.result.current.setup).toBe("plate"));

    const faces = renderHook(() => useSeenElsewhere(stranger, "30m"), {
      wrapper: wrapper({ ...server, config: config({ face: true }) }),
    });
    await waitFor(() => expect(faces.result.current.setup).toBe("similar"));

    // with semantic search on it can look, so there is nothing to suggest
    const similar = renderHook(() => useSeenElsewhere(stranger, "30m"), {
      wrapper: wrapper({ ...server, config: config({ semantic: true }) }),
    });
    await waitFor(() => expect(similar.result.current.active).toBe(true));
    expect(similar.result.current.setup).toBeUndefined();
  });
});
