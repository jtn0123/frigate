/**
 * Wall display (kiosk) logic (UI19, flag `kioskMode`).
 *
 * Pure helpers behind the chrome-free `/kiosk` route: the query string it
 * reads, the link the setup dialog builds, the cameras each slide shows,
 * the grid geometry, the alert takeover rule and queue, the stream fallback
 * and the session keep-alive interval. Kept free of React so the app shell
 * can import `isKioskPath` without pulling in the page.
 */

import type { LivePlayerError, LivePlayerMode } from "@/types/live";
import type { FrigateReview } from "@/types/ws";

export const KIOSK_PATH = "/kiosk";

/** The source key of `?cameras=...`, which is never a camera group name. */
export const CUSTOM_SOURCE = "";

/** The group key that means every dashboard camera, as on Live. */
export const DEFAULT_GROUP = "default";

/** Shortest and longest cycle a link may ask for, in seconds. */
export const MIN_CYCLE_SECONDS = 5;
export const MAX_CYCLE_SECONDS = 3600;

/** Most tiles one grid page may hold. */
export const MAX_TILES = 36;

/** How long an alert keeps its camera on screen, in milliseconds. */
export const TAKEOVER_MS = 20_000;

/** Choices the setup dialog offers. */
export const CYCLE_CHOICES = [0, 10, 15, 30, 60, 120, 300] as const;
export const TILE_CHOICES = [0, 4, 6, 9, 16] as const;

export type KioskMode = "grid" | "single";

export type KioskSettings = {
  /** Camera groups in cycle order; `default` is every dashboard camera. */
  groups: string[];
  /** Explicit camera list; when present it replaces `groups`. */
  cameras: string[];
  mode: KioskMode;
  /** Seconds per slide; 0 holds the first slide. */
  cycle: number;
  /** Tiles per grid page; 0 puts a whole group on one page. */
  tiles: number;
  /** Arrange a whole group as its saved Live layout when one exists. */
  savedLayout: boolean;
  clock: boolean;
  alerts: boolean;
};

export const DEFAULT_KIOSK_SETTINGS: KioskSettings = {
  groups: [DEFAULT_GROUP],
  cameras: [],
  mode: "grid",
  cycle: 0,
  tiles: 0,
  savedLayout: true,
  clock: false,
  alerts: false,
};

/** `window.baseUrl` with a trailing slash; "/" when Frigate is at the root. */
function basePath(): string {
  const rawBase = window.baseUrl || "/";
  return rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
}

/**
 * True only when the path is the kiosk route. Takes the router's pathname
 * and `window.location.pathname` (which carries `window.baseUrl`).
 */
export function isKioskPath(pathname: string): boolean {
  const base = basePath();
  const path =
    base !== "/" && pathname.startsWith(base)
      ? pathname.slice(base.length - 1)
      : pathname;
  return /^\/kiosk\/?$/.test(path);
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part.replaceAll("+", " "));
  } catch {
    return part;
  }
}

/**
 * Raw query pairs, with list values split on literal commas before they are
 * decoded, so a group whose name holds a comma survives as `%2C`.
 */
function queryLists(search: string): Map<string, string[]> {
  const lists = new Map<string, string[]>();
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decodePart(eq === -1 ? pair : pair.slice(0, eq));
    const raw = eq === -1 ? "" : pair.slice(eq + 1);
    const values = raw
      .split(",")
      .map((value) => decodePart(value).trim())
      .filter((value) => value.length > 0);
    lists.set(key, [...(lists.get(key) ?? []), ...values]);
  }
  return lists;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function flag(values: string[] | undefined): boolean {
  const value = values?.at(-1)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function integer(values: string[] | undefined): number {
  const value = values?.at(-1);
  if (value === undefined || !/^\d+$/.test(value)) return 0;
  return Number.parseInt(value, 10);
}

/** Clamp a requested cycle to the supported range; 0 stays off. */
export function clampCycle(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(
    MAX_CYCLE_SECONDS,
    Math.max(MIN_CYCLE_SECONDS, Math.round(seconds)),
  );
}

/** Read the kiosk query string; unknown or malformed values fall back. */
export function parseKioskSearch(search: string): KioskSettings {
  const lists = queryLists(search);
  const cameras = unique(lists.get("cameras") ?? []);
  const groups = unique(lists.get("group") ?? []);
  const tiles = integer(lists.get("tiles"));
  return {
    groups:
      cameras.length === 0 && groups.length === 0 ? [DEFAULT_GROUP] : groups,
    cameras,
    mode: lists.get("mode")?.at(-1) === "single" ? "single" : "grid",
    cycle: clampCycle(integer(lists.get("cycle"))),
    tiles: Math.min(MAX_TILES, tiles),
    savedLayout: lists.get("layout")?.at(-1) !== "auto",
    clock: flag(lists.get("clock")),
    alerts: flag(lists.get("alerts")),
  };
}

function encodeList(values: string[]): string {
  return values.map((value) => encodeURIComponent(value)).join(",");
}

/** The query string for a setup, leaving out values that are the default. */
export function buildKioskSearch(settings: KioskSettings): string {
  const parts: string[] = [];
  if (settings.cameras.length > 0) {
    parts.push(`cameras=${encodeList(settings.cameras)}`);
  } else {
    const groups =
      settings.groups.length > 0 ? settings.groups : [DEFAULT_GROUP];
    parts.push(`group=${encodeList(groups)}`);
  }
  if (settings.mode === "single") parts.push("mode=single");
  if (settings.mode === "grid" && settings.tiles > 0) {
    parts.push(`tiles=${Math.min(MAX_TILES, settings.tiles)}`);
  }
  if (settings.mode === "grid" && !settings.savedLayout) {
    parts.push("layout=auto");
  }
  const cycle = clampCycle(settings.cycle);
  if (cycle > 0) parts.push(`cycle=${cycle}`);
  if (settings.clock) parts.push("clock=1");
  if (settings.alerts) parts.push("alerts=1");
  return `?${parts.join("&")}`;
}

/** Router path (no base URL) for a setup. */
export function kioskRoute(settings: KioskSettings): string {
  return `${KIOSK_PATH}${buildKioskSearch(settings)}`;
}

/** Absolute link for a setup, for the display's browser. */
export function kioskUrl(
  settings: KioskSettings,
  origin = window.location.origin,
): string {
  return `${origin}${basePath()}kiosk${buildKioskSearch(settings)}`;
}

// ---- cameras -------------------------------------------------------------

/** The parts of the Frigate config the kiosk reads. */
export type KioskConfig = {
  cameras: Partial<
    Record<
      string,
      {
        name: string;
        enabled_in_config: boolean;
        ui: { dashboard: boolean; order: number };
      }
    >
  >;
  camera_groups: Partial<Record<string, { cameras: string[]; order: number }>>;
};

export type KioskSource = {
  /** Group name, `default`, or CUSTOM_SOURCE for `?cameras=`. */
  key: string;
  cameras: string[];
};

/**
 * Cameras each requested source shows, in Live's order. Unknown groups and
 * cameras, cameras that are disabled in the config and cameras the user may
 * not view are dropped, and so are sources left empty.
 */
export function resolveKioskSources(
  config: KioskConfig,
  settings: KioskSettings,
  allowedCameras: readonly string[],
): KioskSource[] {
  const allowed = new Set(allowedCameras);
  const usable = (name: string) => {
    const camera = config.cameras[name];
    return (
      camera !== undefined && camera.enabled_in_config && allowed.has(name)
    );
  };
  const byOrder = (a: string, b: string) =>
    (config.cameras[a]?.ui.order ?? 0) - (config.cameras[b]?.ui.order ?? 0);

  if (settings.cameras.length > 0) {
    const cameras = settings.cameras.filter(usable);
    return cameras.length > 0 ? [{ key: CUSTOM_SOURCE, cameras }] : [];
  }

  const sources: KioskSource[] = [];
  for (const key of settings.groups) {
    let cameras: string[];
    if (key === DEFAULT_GROUP) {
      cameras = Object.values(config.cameras).flatMap((camera) =>
        camera?.ui.dashboard ? [camera.name] : [],
      );
    } else {
      const group = config.camera_groups[key];
      if (group === undefined) continue;
      cameras = group.cameras;
    }
    const shown = cameras.filter(usable).sort(byOrder);
    if (shown.length > 0) sources.push({ key, cameras: shown });
  }
  return sources;
}

export type KioskSlide = {
  /** Source the slide belongs to. */
  source: string;
  cameras: string[];
  /** Page of the source (grid) or position in the camera list (single). */
  page: number;
  pages: number;
};

/**
 * Split sources into the slides the display steps through. Grid mode makes
 * one slide per page of each source; single mode makes one slide per camera,
 * each camera once even when it is in several groups.
 */
export function buildKioskSlides(
  sources: readonly KioskSource[],
  mode: KioskMode,
  tiles: number,
): KioskSlide[] {
  if (mode === "single") {
    const seen = new Set<string>();
    const singles: { source: string; camera: string }[] = [];
    for (const source of sources) {
      for (const camera of source.cameras) {
        if (seen.has(camera)) continue;
        seen.add(camera);
        singles.push({ source: source.key, camera });
      }
    }
    return singles.map(({ source, camera }, index) => ({
      source,
      cameras: [camera],
      page: index,
      pages: singles.length,
    }));
  }

  const slides: KioskSlide[] = [];
  for (const source of sources) {
    const size = tiles > 0 ? tiles : source.cameras.length;
    const pages = Math.max(1, Math.ceil(source.cameras.length / size));
    for (let page = 0; page < pages; page++) {
      slides.push({
        source: source.key,
        cameras: source.cameras.slice(page * size, (page + 1) * size),
        page,
        pages,
      });
    }
  }
  return slides;
}

/** Move `delta` slides from `index`, wrapping in both directions. */
export function stepIndex(index: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

// ---- geometry ------------------------------------------------------------

export type GridShape = {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
};

/**
 * Columns and rows that give `count` tiles of `aspect` the largest size in a
 * `width` by `height` area with `gap` pixels between tiles.
 */
export function bestGridShape(
  count: number,
  width: number,
  height: number,
  gap = 0,
  aspect = 16 / 9,
): GridShape {
  const empty = { cols: 1, rows: 1, cellWidth: 0, cellHeight: 0 };
  if (count <= 0 || width <= 0 || height <= 0) return empty;
  let best = empty;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const maxWidth = (width - gap * (cols - 1)) / cols;
    const maxHeight = (height - gap * (rows - 1)) / rows;
    const cellWidth = Math.min(maxWidth, maxHeight * aspect);
    if (cellWidth > best.cellWidth) {
      best = { cols, rows, cellWidth, cellHeight: cellWidth / aspect };
    }
  }
  return best;
}

/** A saved Live grid item (react-grid-layout units: 12 columns). */
export type SavedLayoutItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type FittedTile = {
  camera: string;
  /** Position and size as fractions of the fitted box. */
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FittedLayout = {
  /** Box size in pixels, centred in the area. */
  width: number;
  height: number;
  tiles: FittedTile[];
};

/**
 * Scale a saved Live layout to fit an area without scrolling. A grid row is
 * 9/16 of a column, so the 4 by 4 tile Live creates stays 16:9. The layout's
 * used columns and rows are kept; empty space around them is dropped.
 */
export function fitSavedLayout(
  items: readonly SavedLayoutItem[],
  width: number,
  height: number,
): FittedLayout | undefined {
  if (items.length === 0 || width <= 0 || height <= 0) return undefined;
  const rowUnit = 9 / 16;
  const minX = Math.min(...items.map((item) => item.x));
  const minY = Math.min(...items.map((item) => item.y));
  const maxX = Math.max(...items.map((item) => item.x + item.w));
  const maxY = Math.max(...items.map((item) => item.y + item.h));
  const cols = maxX - minX;
  const rows = maxY - minY;
  if (cols <= 0 || rows <= 0) return undefined;
  const scale = Math.min(width / cols, height / (rows * rowUnit));
  return {
    width: cols * scale,
    height: rows * rowUnit * scale,
    tiles: items.map((item) => ({
      camera: item.i,
      left: (item.x - minX) / cols,
      top: (item.y - minY) / rows,
      width: item.w / cols,
      height: item.h / rows,
    })),
  };
}

// ---- alerts --------------------------------------------------------------

export type KioskTakeover = {
  reviewId: string;
  camera: string;
  /** Object labels, untranslated. */
  objects: string[];
  /** Audio labels, untranslated. */
  audio: string[];
  /** Recognized names and plates, shown as they are. */
  subLabels: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSegment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const data = value["data"];
  return (
    typeof value["id"] === "string" &&
    typeof value["camera"] === "string" &&
    typeof value["severity"] === "string" &&
    isRecord(data) &&
    Array.isArray(data["objects"]) &&
    Array.isArray(data["audio"])
  );
}

function isReviewMessage(value: unknown): value is FrigateReview {
  return (
    isRecord(value) &&
    typeof value["type"] === "string" &&
    isSegment(value["before"]) &&
    isSegment(value["after"])
  );
}

/**
 * A `reviews` topic payload (a JSON string) as a review message, or
 * undefined when it is not one.
 */
export function reviewFromPayload(payload: unknown): FrigateReview | undefined {
  if (typeof payload !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  return isReviewMessage(parsed) ? parsed : undefined;
}

/**
 * The takeover a `reviews` message starts, if any: a review that is an alert
 * for the first time on a camera the display shows, and not one it has
 * already taken over for.
 *
 * An alert is new when it arrives as "new", when an update upgrades a
 * detection to it, or when an update names an alert that started at or after
 * `since` (seconds). Frigate opens the segments of manual API events and
 * audio alerts without a "new" message, so their first message is already
 * an update; `since` (when the display opened) keeps the updates of alerts
 * that were running before then from taking over.
 */
export function takeoverFromReview(
  review: FrigateReview | undefined,
  cameras: ReadonlySet<string>,
  seen: ReadonlySet<string>,
  since: number = Number.POSITIVE_INFINITY,
): KioskTakeover | undefined {
  if (!review) return undefined;
  const { before, after } = review;
  if (after.severity !== "alert") return undefined;
  const becameAlert =
    review.type === "new" ||
    (review.type === "update" &&
      (before.severity !== "alert" || after.start_time >= since));
  if (!becameAlert || seen.has(after.id) || !cameras.has(after.camera)) {
    return undefined;
  }
  const data = after.data;
  return {
    reviewId: after.id,
    camera: after.camera,
    // "person-verified" is a person identified by its sub label (a face or a
    // plate), which names it instead
    objects: unique(
      data.objects.filter((label) => !label.endsWith("-verified")),
    ),
    audio: unique(data.audio),
    subLabels: unique(data.sub_labels ?? []),
  };
}

/** Alerts waiting for the screen; the first one is showing. */
export type KioskTakeoverQueue = readonly KioskTakeover[];

/**
 * Add an alert to the takeover queue, so alerts that start together take
 * turns instead of the last one replacing the others. Each review gets one
 * turn. A camera waits at most once: a newer alert for a camera that is
 * already waiting joins that entry (its labels are added and the newer
 * review names it), which also keeps the queue no longer than the display's
 * camera list plus the one showing. A new alert on the camera showing now
 * waits for a turn of its own.
 */
export function queueTakeover(
  queue: KioskTakeoverQueue,
  next: KioskTakeover,
): KioskTakeoverQueue {
  if (queue.some((entry) => entry.reviewId === next.reviewId)) return queue;
  const waiting = queue.findIndex(
    (entry, index) => index > 0 && entry.camera === next.camera,
  );
  if (waiting === -1) return [...queue, next];
  return queue.map((entry, index) =>
    index === waiting
      ? {
          reviewId: next.reviewId,
          camera: next.camera,
          objects: unique([...entry.objects, ...next.objects]),
          audio: unique([...entry.audio, ...next.audio]),
          subLabels: unique([...entry.subLabels, ...next.subLabels]),
        }
      : entry,
  );
}

/**
 * End one alert's turn. Taking the review id, rather than always dropping
 * the first entry, makes a dismissal that races the timeout end only that
 * alert instead of skipping the next one too.
 */
export function dismissTakeover(
  queue: KioskTakeoverQueue,
  reviewId: string,
): KioskTakeoverQueue {
  return queue.at(0)?.reviewId === reviewId ? queue.slice(1) : queue;
}

// ---- streaming -----------------------------------------------------------

export type KioskStreamSettings = {
  streamName?: string;
  streamType?: "no-streaming" | "smart" | "continuous";
  compatibilityMode?: boolean;
};

export type KioskTileStream = {
  streamName: string;
  autoLive: boolean;
  showStillWithoutActivity: boolean;
  useWebGL: boolean;
};

/**
 * How a tile streams. Grid tiles follow the group's streaming settings the
 * way Live's dashboard does; a camera alone on screen (single mode and alert
 * takeover) streams continuously, like Live's single camera view.
 */
export function tileStream(
  streams: Record<string, string>,
  settings: KioskStreamSettings | undefined,
  globalAutoLive: boolean,
  alone: boolean,
): KioskTileStream {
  const available = Object.values(streams);
  const requested = settings?.streamName;
  const streamName =
    requested && available.includes(requested)
      ? requested
      : (available[0] ?? "");
  const useWebGL = settings?.compatibilityMode ?? false;
  if (alone) {
    return {
      streamName,
      autoLive: true,
      showStillWithoutActivity: false,
      useWebGL,
    };
  }
  const streamType = settings?.streamType;
  return {
    streamName,
    autoLive:
      streamType === undefined ? globalAutoLive : streamType !== "no-streaming",
    showStillWithoutActivity: streamType !== "continuous",
    useWebGL,
  };
}

/**
 * The live mode a tile falls back to after a player error, as on Live's
 * dashboard: WebRTC after an MSE decode error when it is usable, jsmpeg
 * otherwise.
 */
export function fallbackLiveMode(
  error: LivePlayerError,
  webRTCUsable: boolean,
): LivePlayerMode {
  return error === "mse-decode" && webRTCUsable ? "webrtc" : "jsmpeg";
}

// ---- session -------------------------------------------------------------

/** Longest wait between the keep-alive requests, in milliseconds. */
export const KEEP_ALIVE_MS = 600_000;

/**
 * How often the display requests the API to keep its session alive, in
 * milliseconds, or 0 when there is no session to keep.
 *
 * Frigate renews a session cookie only on an HTTP response, and only in the
 * last `auth.refresh_time` seconds of the session. Streams and the event
 * socket are WebSocket upgrades that never carry the new cookie, so a display
 * that only streams makes no requests after loading and would be signed out
 * when the session ends (24 hours by default). Asking at least twice per
 * refresh window always lands a request inside it. Takes `config.auth`.
 */
export function keepAliveMs(auth: unknown): number {
  if (!isRecord(auth)) return KEEP_ALIVE_MS;
  if (auth["enabled"] === false) return 0;
  const refreshTime = auth["refresh_time"];
  if (typeof refreshTime !== "number" || !(refreshTime > 0)) {
    return KEEP_ALIVE_MS;
  }
  return Math.min(KEEP_ALIVE_MS, (refreshTime * 1000) / 2);
}
