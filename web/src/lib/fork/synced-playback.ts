/**
 * Fork (UI143): the pure parts of synced multi-camera playback.
 *
 * The grid runs one master clock and treats every tile's player as a
 * follower. These helpers decide, from plain numbers, what the clock and
 * each tile should do next, so the decisions are unit tested without a
 * browser: recording coverage per camera, recording gaps, drift correction
 * and when the group waits for a slow tile.
 */

import type { DynamicVideoController } from "@/components/player/dynamic/DynamicVideoController";

/** The controller surface the recording view drives, single or grid. */
export type PlaybackControllerLike = Pick<
  DynamicVideoController,
  "play" | "pause" | "isPlaying" | "seekToTimestamp" | "scrubToTimestamp"
>;

/** Browsers decode a handful of streams at once; four is the safe cap. */
export const MAX_SYNCED_TILES = 4;
/** Phones get two tiles, stacked in portrait. */
export const MAX_SYNCED_TILES_PHONE = 2;
/** The default grid fills up to this many tiles even without activity. */
export const MIN_DEFAULT_TILES = 2;
/** Review items this close to the playhead count as activity. */
export const ACTIVITY_WINDOW_S = 300;

/** How often the sync loop reconciles the tiles with the master clock. */
export const SYNC_TICK_MS = 200;
/** Drift inside this band is left alone. */
export const DRIFT_DEADBAND_S = 0.12;
/** Drift past this (scaled up at high speeds) is fixed with a seek. */
export const DRIFT_SEEK_S = 0.4;
/** A paused tile further than this from the master frame is re-seeked. */
export const PAUSED_ALIGN_S = 0.25;
/** The largest playback rate change used to pull a tile back in line. */
export const NUDGE_MAX = 0.1;
/** Rate change per second of drift, before the clamp above. */
export const NUDGE_GAIN = 0.25;
/** A tile is not seeked again for this long after a seek. */
export const SEEK_COOLDOWN_MS = 1500;
/** A buffering tile shorter than this never stops the group. */
export const HOLD_GRACE_MS = 250;
/** The group never waits longer than this for one tile. */
export const MAX_HOLD_MS = 4000;
/** A seek lands this far (times the rate) ahead, covering its own latency. */
export const SEEK_LEAD_S = 0.1;
/** Recording rows rarely butt exactly; closer gaps than this are joined. */
export const COVERAGE_GAP_TOLERANCE_S = 1.5;
/** Speeds offered by the grid; several streams cannot decode 16x. */
export const SYNCED_PLAYBACK_RATES = [0.5, 1, 2, 4, 8];
/** Footage this close to the end of the view is still being saved. */
export const LIVE_EDGE_S = 60;

/**
 * The grid speed for a chosen `rate`. The grid shares the choice with the
 * single player, which offers 16x; the grid plays the fastest speed it has
 * at or below it (its slowest for anything slower).
 */
export function clampSyncedRate(rate: number): number {
  const allowed = SYNCED_PLAYBACK_RATES.filter((option) => option <= rate);

  return allowed.length > 0
    ? Math.max(...allowed)
    : Math.min(...SYNCED_PLAYBACK_RATES);
}

export type TimeSpan = { start_time: number; end_time: number };

/** Sorts spans and joins the ones closer than `tolerance` seconds. */
export function mergeSpans(
  spans: readonly TimeSpan[],
  tolerance: number = COVERAGE_GAP_TOLERANCE_S,
): TimeSpan[] {
  const sorted = [...spans]
    .filter((span) => span.end_time > span.start_time)
    .sort((a, b) => a.start_time - b.start_time);
  const merged: TimeSpan[] = [];

  for (const span of sorted) {
    const last = merged.at(-1);

    if (last && span.start_time <= last.end_time + tolerance) {
      last.end_time = Math.max(last.end_time, span.end_time);
    } else {
      merged.push({ start_time: span.start_time, end_time: span.end_time });
    }
  }

  return merged;
}

/** Whether merged `spans` hold recording at `time`. */
export function isCoveredAt(spans: readonly TimeSpan[], time: number) {
  return spans.some((span) => span.start_time <= time && time < span.end_time);
}

/** The start of the first span after `time`, if any. */
export function nextCoverageStart(
  spans: readonly TimeSpan[],
  time: number,
): number | undefined {
  return spans.find((span) => span.start_time > time)?.start_time;
}

/**
 * Whether a camera without footage at `time` has only caught up with the
 * footage still being saved: nothing follows in the chunk, the chunk is the
 * newest the view covers, and the camera recorded until shortly before the
 * view's end. Coverage is read once per chunk and segments are saved a
 * little after they are filmed, so the newest seconds are always missing.
 */
export function isAtLiveEdge(
  spans: readonly TimeSpan[],
  time: number,
  chunk: { after: number; before: number },
  latestTime: number,
): boolean {
  if (
    chunk.before < Math.floor(latestTime) ||
    nextCoverageStart(spans, time) !== undefined
  ) {
    return false;
  }

  // spans are merged and sorted, and none starts after `time`
  const lastEnd = spans.at(-1)?.end_time ?? chunk.after;

  return lastEnd >= latestTime - LIVE_EDGE_S;
}

export type GapPlan =
  | { kind: "none" }
  | { kind: "seek"; time: number }
  | { kind: "advance" }
  | { kind: "end" };

/**
 * What the master clock does when it may be inside a gap every camera
 * shares: nothing while any camera records (or coverage is still loading),
 * jump to the earliest next recording in the chunk, move on to the next
 * chunk, or stop at the end of the footage.
 */
export function planGapSkip(
  coverages: readonly (readonly TimeSpan[] | undefined)[],
  time: number,
  chunkEnd: number,
  latestTime: number,
): GapPlan {
  if (coverages.length == 0) {
    return { kind: "none" };
  }

  let next: number | undefined;

  for (const spans of coverages) {
    if (spans === undefined || isCoveredAt(spans, time)) {
      return { kind: "none" };
    }

    const start = nextCoverageStart(spans, time);

    if (start !== undefined && start < chunkEnd) {
      next = next === undefined ? start : Math.min(next, start);
    }
  }

  if (next !== undefined) {
    return { kind: "seek", time: next };
  }

  return chunkEnd < latestTime ? { kind: "advance" } : { kind: "end" };
}

/**
 * The master clock. Time is wall-clock seconds; `at` is the
 * `performance.now()` reading the time was taken at.
 */
export type SyncClock = {
  time: number;
  at: number;
  playing: boolean;
  holding: boolean;
  rate: number;
};

/** The master time at `nowMs`; frozen while paused or holding. */
export function clockNow(clock: SyncClock, nowMs: number): number {
  if (!clock.playing || clock.holding) {
    return clock.time;
  }

  return clock.time + ((nowMs - clock.at) / 1000) * clock.rate;
}

/** Re-anchors the clock at `nowMs`, then applies `patch`. */
export function updateClock(
  clock: SyncClock,
  nowMs: number,
  patch: Partial<Omit<SyncClock, "at">> = {},
): SyncClock {
  return {
    ...clock,
    time: clockNow(clock, nowMs),
    ...patch,
    at: nowMs,
  };
}

/** DynamicVideoPlayer's source grid; its playlists start on these marks. */
export const SOURCE_START_GRID_S = 10;

/**
 * Where a tile's playlist starts for `anchor` (mirrors DynamicVideoPlayer).
 * The player cannot seek before this without loading a new source.
 */
export function sourceWindowStart(
  anchor: number | undefined,
  chunk: { after: number; before: number },
): number {
  if (anchor !== undefined && anchor > chunk.after && anchor < chunk.before) {
    return Math.max(
      chunk.after,
      Math.floor(anchor / SOURCE_START_GRID_S) * SOURCE_START_GRID_S,
    );
  }

  return chunk.after;
}

/** The seek threshold grows at high speed, where small drift is invisible. */
export function seekThreshold(rate: number): number {
  return DRIFT_SEEK_S * Math.max(1, rate / 2);
}

/** Where a correcting seek aims so the tile lands on the moving clock. */
export function seekTarget(masterTime: number, playing: boolean, rate: number) {
  return playing ? masterTime + SEEK_LEAD_S * rate : masterTime;
}

/** The playback rate that pulls a tile `drift` seconds off back in line. */
export function nudgedRate(rate: number, drift: number | undefined): number {
  if (drift === undefined || Math.abs(drift) <= DRIFT_DEADBAND_S) {
    return rate;
  }

  const correction = Math.min(
    NUDGE_MAX,
    Math.max(-NUDGE_MAX, drift * NUDGE_GAIN),
  );

  // a tile ahead (positive drift) slows down, one behind speeds up
  return rate * (1 - correction);
}

/** What the sync loop knows about one tile at a tick. */
export type TileProbe = {
  /** The camera records at the master time. */
  covered: boolean;
  /** The tile has a video element with a loaded source. */
  hasVideo: boolean;
  /** The video can play from where it is (has data, not seeking). */
  ready: boolean;
  paused: boolean;
  /** Tile time minus master time, once the tile has reported a time. */
  drift: number | undefined;
  sinceSeekMs: number;
  /** How long the tile has been unready; 0 while ready. */
  notReadyMs: number;
  /** The tile has been ready at least once since it mounted. */
  joined: boolean;
};

export type MasterState = { playing: boolean; holding: boolean; rate: number };

export type TileAction =
  | { kind: "gap" }
  | { kind: "wait" }
  | { kind: "pause" }
  | { kind: "seek"; play: boolean }
  | { kind: "play"; rate: number };

/** The one thing the loop does to a tile this tick. */
export function decideTile(probe: TileProbe, master: MasterState): TileAction {
  if (!probe.covered) {
    return { kind: "gap" };
  }

  const still = !master.playing || master.holding;

  if (!probe.hasVideo || !probe.ready) {
    // a player that autoplayed its fresh source must not run ahead
    return still && !probe.paused ? { kind: "pause" } : { kind: "wait" };
  }

  const canSeek = probe.sinceSeekMs >= SEEK_COOLDOWN_MS;
  const drift = probe.drift;

  if (still) {
    // an unknown position is found out with a seek, which reports back
    if ((drift === undefined || Math.abs(drift) > PAUSED_ALIGN_S) && canSeek) {
      return { kind: "seek", play: false };
    }

    return { kind: "pause" };
  }

  if (
    drift !== undefined &&
    Math.abs(drift) > seekThreshold(master.rate) &&
    canSeek
  ) {
    return { kind: "seek", play: true };
  }

  return { kind: "play", rate: nudgedRate(master.rate, drift) };
}

/**
 * Whether the master clock waits for its tiles.
 *
 * After a master command (mount, seek, play) the clock waits until every
 * camera that records at the master time is loaded and has reported a
 * position on the master frame, so all tiles start together. During playback a tile buffering
 * past a short grace pauses the group too. Neither wait outlasts
 * MAX_HOLD_MS, so one broken stream cannot freeze the grid.
 */
export function shouldHold(
  probes: readonly TileProbe[],
  playing: boolean,
  awaitingMs: number | undefined,
): boolean {
  if (!playing) {
    return false;
  }

  if (awaitingMs !== undefined && awaitingMs < MAX_HOLD_MS) {
    return probes.some(
      (probe) =>
        probe.covered &&
        // a tile that never loaded in MAX_HOLD_MS is broken, not slow
        (probe.joined || probe.notReadyMs < MAX_HOLD_MS) &&
        (!probe.hasVideo ||
          !probe.ready ||
          probe.drift === undefined ||
          Math.abs(probe.drift) > PAUSED_ALIGN_S),
    );
  }

  return probes.some(
    (probe) =>
      probe.covered &&
      probe.joined &&
      !probe.ready &&
      probe.notReadyMs >= HOLD_GRACE_MS &&
      probe.notReadyMs < MAX_HOLD_MS,
  );
}

export type ActivityItem = {
  camera: string;
  start_time: number;
  end_time?: number | null;
};

/** Seconds between `time` and an item, 0 when the item spans it. */
function distanceTo(item: ActivityItem, time: number): number {
  const end = item.end_time ?? item.start_time;

  if (time < item.start_time) {
    return item.start_time - time;
  }

  return time > end ? time - end : 0;
}

/**
 * The cameras a fresh grid shows: the main camera, then the cameras with
 * activity nearest the playhead, then (only to reach `min`) the rest of the
 * group in its own order.
 */
export function pickDefaultCameras({
  mainCamera,
  cameras,
  activity,
  time,
  max = MAX_SYNCED_TILES,
  min = MIN_DEFAULT_TILES,
  windowS = ACTIVITY_WINDOW_S,
}: {
  mainCamera: string;
  cameras: readonly string[];
  activity: readonly ActivityItem[];
  time: number;
  max?: number;
  min?: number;
  windowS?: number;
}): string[] {
  const picked = cameras.includes(mainCamera) ? [mainCamera] : [];
  const nearest = new Map<string, number>();

  for (const item of activity) {
    if (item.camera == mainCamera || !cameras.includes(item.camera)) {
      continue;
    }

    const distance = distanceTo(item, time);

    if (distance <= windowS) {
      nearest.set(
        item.camera,
        Math.min(nearest.get(item.camera) ?? Infinity, distance),
      );
    }
  }

  const active = [...nearest.entries()]
    .sort(
      (a, b) => a[1] - b[1] || cameras.indexOf(a[0]) - cameras.indexOf(b[0]),
    )
    .map(([camera]) => camera);

  for (const camera of active) {
    if (picked.length >= max) {
      break;
    }
    picked.push(camera);
  }

  for (const camera of cameras) {
    if (picked.length >= Math.min(min, max)) {
      break;
    }
    if (!picked.includes(camera)) {
      picked.push(camera);
    }
  }

  return picked;
}

/** Keeps a selection valid: known cameras only, no repeats, at most `max`. */
export function clampSelection(
  selection: readonly string[],
  cameras: readonly string[],
  max: number,
): string[] {
  return [...new Set(selection)]
    .filter((camera) => cameras.includes(camera))
    .slice(0, max);
}

export type GridLayout = { cols: number; rows: number };

/** The largest box of `aspect` (width / height) that fits `width` x `height`. */
export function fitBox(
  width: number,
  height: number,
  aspect: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0 || aspect <= 0 || Number.isNaN(aspect)) {
    return { width: 0, height: 0 };
  }

  return width / height > aspect
    ? { width: height * aspect, height }
    : { width, height: width / aspect };
}

/**
 * A grid shape with more columns wins unless one with fewer columns gives
 * its tiles at least this much more area (about 15% more width). Side by
 * side is how cameras are compared, and on a 1440x900 screen two stacked
 * tiles were only 15% larger yet left 294 px empty on each side.
 */
export const MORE_COLUMNS_AREA_SLACK = 4 / 3;

/**
 * The grid shape for `count` tiles of `aspect` in a `width` x `height` area
 * with `gap` pixels between cells: the one with the most columns whose
 * tiles are close to the largest any shape allows. Two tiles sit side by
 * side in a landscape area and stack in a tall one (a phone in portrait);
 * four make a 2x2 unless the area is very wide or very tall.
 */
export function pickGridLayout(
  count: number,
  width: number,
  height: number,
  aspect: number = 16 / 9,
  gap: number = 8,
): GridLayout {
  if (count <= 1) {
    return { cols: 1, rows: 1 };
  }

  if (width <= 0 || height <= 0) {
    return { cols: Math.min(count, 2), rows: Math.ceil(count / 2) };
  }

  const shapes: (GridLayout & { area: number })[] = [];

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);

    // a column count leaving a whole row empty is never the better shape
    if ((cols - 1) * rows >= count && cols > 1) {
      continue;
    }

    const cell = fitBox(
      (width - gap * (cols - 1)) / cols,
      (height - gap * (rows - 1)) / rows,
      aspect,
    );
    shapes.push({ cols, rows, area: cell.width * cell.height });
  }

  const largest = Math.max(...shapes.map((shape) => shape.area));
  let best: GridLayout = { cols: 1, rows: count };

  // the shapes run from the fewest columns to the most
  for (const { cols, rows, area } of shapes) {
    if (area > 0 && area * MORE_COLUMNS_AREA_SLACK >= largest) {
      best = { cols, rows };
    }
  }

  return best;
}
