import { afterEach, describe, expect, it } from "vitest";
import type { FrigateReview } from "@/types/ws";
import type { ReviewSegment } from "@/types/review";
import {
  CUSTOM_SOURCE,
  DEFAULT_KIOSK_SETTINGS,
  KEEP_ALIVE_MS,
  MAX_CYCLE_SECONDS,
  MAX_TILES,
  MIN_CYCLE_SECONDS,
  bestGridShape,
  buildKioskSearch,
  buildKioskSlides,
  clampCycle,
  dismissTakeover,
  fallbackLiveMode,
  fitSavedLayout,
  isKioskPath,
  keepAliveMs,
  kioskRoute,
  kioskUrl,
  parseKioskSearch,
  queueTakeover,
  resolveKioskSources,
  reviewFromPayload,
  stepIndex,
  takeoverFromReview,
  tileStream,
  type KioskConfig,
  type KioskSettings,
  type KioskTakeover,
  type KioskTakeoverQueue,
} from "./kiosk";

afterEach(() => {
  delete window.baseUrl;
});

describe("isKioskPath", () => {
  it("matches the kiosk route only", () => {
    expect(isKioskPath("/kiosk")).toBe(true);
    expect(isKioskPath("/kiosk/")).toBe(true);
    expect(isKioskPath("/kiosks")).toBe(false);
    expect(isKioskPath("/review/kiosk")).toBe(false);
    expect(isKioskPath("/")).toBe(false);
  });

  it("strips the base URL from the window pathname", () => {
    window.baseUrl = "/frigate/";
    expect(isKioskPath("/frigate/kiosk")).toBe(true);
    expect(isKioskPath("/kiosk")).toBe(true);
    expect(isKioskPath("/frigate/live")).toBe(false);
  });

  it("accepts a base URL without a trailing slash", () => {
    window.baseUrl = "/frigate";
    expect(isKioskPath("/frigate/kiosk")).toBe(true);
  });
});

describe("parseKioskSearch", () => {
  it("defaults to every dashboard camera in a still grid", () => {
    expect(parseKioskSearch("")).toEqual(DEFAULT_KIOSK_SETTINGS);
    expect(parseKioskSearch("?")).toEqual(DEFAULT_KIOSK_SETTINGS);
  });

  it("reads every option", () => {
    expect(
      parseKioskSearch(
        "?group=outdoor,garage&mode=single&cycle=30&tiles=4&layout=auto&clock=1&alerts=true",
      ),
    ).toEqual({
      groups: ["outdoor", "garage"],
      cameras: [],
      mode: "single",
      cycle: 30,
      tiles: 4,
      savedLayout: false,
      clock: true,
      alerts: true,
    });
  });

  it("joins repeated group parameters and drops duplicates and blanks", () => {
    expect(parseKioskSearch("?group=a&group=b,,a&group=").groups).toEqual([
      "a",
      "b",
    ]);
  });

  it("keeps an encoded comma inside one group name", () => {
    expect(parseKioskSearch("?group=front%2Cback,yard").groups).toEqual([
      "front,back",
      "yard",
    ]);
  });

  it("decodes plus signs and percent escapes", () => {
    expect(parseKioskSearch("?group=front+yard,side%20gate").groups).toEqual([
      "front yard",
      "side gate",
    ]);
  });

  it("keeps a malformed escape as written", () => {
    expect(parseKioskSearch("?group=bad%E0").groups).toEqual(["bad%E0"]);
  });

  it("lets a camera list replace the groups", () => {
    const settings = parseKioskSearch("?cameras=garage,front_door&group=x");
    expect(settings.cameras).toEqual(["garage", "front_door"]);
    expect(settings.groups).toEqual(["x"]);
  });

  it("leaves groups empty when only cameras are given", () => {
    expect(parseKioskSearch("?cameras=garage").groups).toEqual([]);
  });

  it.each([
    ["cycle=2", MIN_CYCLE_SECONDS],
    ["cycle=99999", MAX_CYCLE_SECONDS],
    ["cycle=0", 0],
    ["cycle=-5", 0],
    ["cycle=abc", 0],
    ["cycle=", 0],
    ["cycle", 0],
  ])("reads %s as a cycle of %i seconds", (query, cycle) => {
    expect(parseKioskSearch(`?${query}`).cycle).toBe(cycle);
  });

  it("caps the tiles per page and ignores bad values", () => {
    expect(parseKioskSearch("?tiles=500").tiles).toBe(MAX_TILES);
    expect(parseKioskSearch("?tiles=3.5").tiles).toBe(0);
    expect(parseKioskSearch("?tiles=9").tiles).toBe(9);
  });

  it.each(["1", "true", "yes", "on", "TRUE"])("reads clock=%s as on", (v) => {
    expect(parseKioskSearch(`?clock=${v}`).clock).toBe(true);
  });

  it.each(["0", "false", "no", ""])("reads alerts=%s as off", (v) => {
    expect(parseKioskSearch(`?alerts=${v}`).alerts).toBe(false);
  });

  it("falls back to grid for an unknown mode", () => {
    expect(parseKioskSearch("?mode=mosaic").mode).toBe("grid");
  });
});

describe("clampCycle", () => {
  it("rounds and clamps", () => {
    expect(clampCycle(12.4)).toBe(12);
    expect(clampCycle(Number.NaN)).toBe(0);
    expect(clampCycle(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("buildKioskSearch", () => {
  it("writes only what differs from the defaults", () => {
    expect(buildKioskSearch(DEFAULT_KIOSK_SETTINGS)).toBe("?group=default");
  });

  it("writes every option", () => {
    const settings: KioskSettings = {
      groups: ["outdoor", "garage"],
      cameras: [],
      mode: "grid",
      cycle: 30,
      tiles: 4,
      savedLayout: false,
      clock: true,
      alerts: true,
    };
    expect(buildKioskSearch(settings)).toBe(
      "?group=outdoor,garage&tiles=4&layout=auto&cycle=30&clock=1&alerts=1",
    );
  });

  it("leaves grid-only options out of single mode", () => {
    expect(
      buildKioskSearch({
        ...DEFAULT_KIOSK_SETTINGS,
        mode: "single",
        tiles: 4,
        savedLayout: false,
      }),
    ).toBe("?group=default&mode=single");
  });

  it("prefers a camera list, and falls back to the default group", () => {
    expect(
      buildKioskSearch({ ...DEFAULT_KIOSK_SETTINGS, cameras: ["a", "b"] }),
    ).toBe("?cameras=a,b");
    expect(buildKioskSearch({ ...DEFAULT_KIOSK_SETTINGS, groups: [] })).toBe(
      "?group=default",
    );
  });

  it("round-trips names that need escaping", () => {
    const settings = {
      ...DEFAULT_KIOSK_SETTINGS,
      groups: ["front,back", "side gate", "a&b"],
      cycle: 2,
    };
    const parsed = parseKioskSearch(buildKioskSearch(settings));
    expect(parsed.groups).toEqual(settings.groups);
    expect(parsed.cycle).toBe(MIN_CYCLE_SECONDS);
  });

  it("builds the route and the absolute link", () => {
    window.baseUrl = "/frigate/";
    const settings = { ...DEFAULT_KIOSK_SETTINGS, clock: true };
    expect(kioskRoute(settings)).toBe("/kiosk?group=default&clock=1");
    expect(kioskUrl(settings, "https://nvr.local:8971")).toBe(
      "https://nvr.local:8971/frigate/kiosk?group=default&clock=1",
    );
    window.baseUrl = "";
    expect(kioskUrl(settings, "https://nvr.local")).toBe(
      "https://nvr.local/kiosk?group=default&clock=1",
    );
  });
});

function camera(name: string, order: number, dashboard = true, enabled = true) {
  return { name, enabled_in_config: enabled, ui: { dashboard, order } };
}

const config: KioskConfig = {
  cameras: {
    garage: camera("garage", 3),
    front_door: camera("front_door", 1),
    backyard: camera("backyard", 2),
    attic: camera("attic", 4, false),
    old: camera("old", 0, true, false),
  },
  camera_groups: {
    outdoor: { cameras: ["backyard", "front_door", "missing"], order: 1 },
    indoor: { cameras: ["attic"], order: 2 },
    empty: { cameras: ["old"], order: 3 },
  },
};
const everyone = ["garage", "front_door", "backyard", "attic", "old"];

describe("resolveKioskSources", () => {
  const settings = (patch: Partial<KioskSettings>): KioskSettings => ({
    ...DEFAULT_KIOSK_SETTINGS,
    ...patch,
  });

  it("shows dashboard cameras in Live's order for the default group", () => {
    expect(resolveKioskSources(config, settings({}), everyone)).toEqual([
      { key: "default", cameras: ["front_door", "backyard", "garage"] },
    ]);
  });

  it("orders a group by Live's order and drops unknown cameras", () => {
    expect(
      resolveKioskSources(config, settings({ groups: ["outdoor"] }), everyone),
    ).toEqual([{ key: "outdoor", cameras: ["front_door", "backyard"] }]);
  });

  it("shows a group's non-dashboard cameras", () => {
    expect(
      resolveKioskSources(config, settings({ groups: ["indoor"] }), everyone),
    ).toEqual([{ key: "indoor", cameras: ["attic"] }]);
  });

  it("drops unknown and empty groups", () => {
    expect(
      resolveKioskSources(
        config,
        settings({ groups: ["nope", "empty", "outdoor"] }),
        everyone,
      ).map((source) => source.key),
    ).toEqual(["outdoor"]);
  });

  it("hides cameras the user may not view", () => {
    expect(resolveKioskSources(config, settings({}), ["garage"])).toEqual([
      { key: "default", cameras: ["garage"] },
    ]);
    expect(resolveKioskSources(config, settings({}), [])).toEqual([]);
  });

  it("keeps a camera list in the order given", () => {
    expect(
      resolveKioskSources(
        config,
        settings({ cameras: ["garage", "nope", "old", "front_door"] }),
        everyone,
      ),
    ).toEqual([{ key: CUSTOM_SOURCE, cameras: ["garage", "front_door"] }]);
    expect(
      resolveKioskSources(config, settings({ cameras: ["nope"] }), everyone),
    ).toEqual([]);
  });
});

describe("buildKioskSlides", () => {
  const sources = [
    { key: "default", cameras: ["a", "b", "c", "d", "e", "f"] },
    { key: "outdoor", cameras: ["b", "g"] },
  ];

  it("makes one slide per source when a group fits on one page", () => {
    expect(buildKioskSlides(sources, "grid", 0)).toEqual([
      { source: "default", cameras: sources[0]?.cameras, page: 0, pages: 1 },
      { source: "outdoor", cameras: ["b", "g"], page: 0, pages: 1 },
    ]);
  });

  it("pages a large group", () => {
    const slides = buildKioskSlides(sources, "grid", 4);
    expect(slides.map((slide) => [slide.source, slide.cameras])).toEqual([
      ["default", ["a", "b", "c", "d"]],
      ["default", ["e", "f"]],
      ["outdoor", ["b", "g"]],
    ]);
    expect(slides.map((slide) => `${slide.page}/${slide.pages}`)).toEqual([
      "0/2",
      "1/2",
      "0/1",
    ]);
  });

  it("shows each camera once in single mode", () => {
    const slides = buildKioskSlides(sources, "single", 4);
    expect(slides.map((slide) => slide.cameras[0])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
    expect(slides.at(-1)).toEqual({
      source: "outdoor",
      cameras: ["g"],
      page: 6,
      pages: 7,
    });
  });

  it("has no slides without sources", () => {
    expect(buildKioskSlides([], "grid", 0)).toEqual([]);
    expect(buildKioskSlides([], "single", 0)).toEqual([]);
  });
});

describe("stepIndex", () => {
  it("wraps both ways", () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(1, 3, -4)).toBe(0);
    expect(stepIndex(5, 0, 1)).toBe(0);
  });
});

describe("bestGridShape", () => {
  it("fills a 16:9 screen with one tile", () => {
    expect(bestGridShape(1, 1920, 1080)).toEqual({
      cols: 1,
      rows: 1,
      cellWidth: 1920,
      cellHeight: 1080,
    });
  });

  it("puts four cameras in a 2 by 2 grid", () => {
    const shape = bestGridShape(4, 1920, 1080);
    expect([shape.cols, shape.rows]).toEqual([2, 2]);
    expect(shape.cellWidth).toBe(960);
  });

  it("puts six cameras in 2 columns of 3 rows on a 16:10 screen", () => {
    const shape = bestGridShape(6, 1440, 900);
    expect([shape.cols, shape.rows]).toEqual([2, 3]);
    expect(Math.round(shape.cellWidth)).toBe(533);
  });

  it("stacks cameras on a portrait phone", () => {
    const shape = bestGridShape(3, 412, 915, 6);
    expect([shape.cols, shape.rows]).toEqual([1, 3]);
    expect(shape.cellWidth).toBe(412);
  });

  it("leaves room for the gaps", () => {
    // two rows of (1000 - 10) / 2 = 495 px, which bounds the tiles' width
    const shape = bestGridShape(2, 1000, 1000, 10);
    expect([shape.cols, shape.rows]).toEqual([1, 2]);
    expect(shape.cellWidth).toBeCloseTo(880);
    expect(shape.cellHeight).toBeCloseTo(495);
  });

  it("returns an empty shape for nothing to place", () => {
    expect(bestGridShape(0, 100, 100).cellWidth).toBe(0);
    expect(bestGridShape(2, 0, 100).cellWidth).toBe(0);
  });
});

describe("fitSavedLayout", () => {
  it("scales a two by two arrangement to a 16:9 screen", () => {
    const fitted = fitSavedLayout(
      [
        { i: "a", x: 0, y: 0, w: 4, h: 4 },
        { i: "b", x: 4, y: 0, w: 4, h: 4 },
        { i: "c", x: 0, y: 4, w: 4, h: 4 },
        { i: "d", x: 4, y: 4, w: 4, h: 4 },
      ],
      1600,
      900,
    );
    expect(fitted?.width).toBe(1600);
    expect(fitted?.height).toBe(900);
    expect(fitted?.tiles[3]).toEqual({
      camera: "d",
      left: 0.5,
      top: 0.5,
      width: 0.5,
      height: 0.5,
    });
  });

  it("keeps a big tile big and drops unused space", () => {
    const fitted = fitSavedLayout(
      [
        { i: "big", x: 2, y: 3, w: 8, h: 8 },
        { i: "side", x: 10, y: 3, w: 4, h: 4 },
      ],
      1200,
      1200,
    );
    // 12 columns wide, 8 rows (4.5 column units) tall: width bound
    expect(fitted?.width).toBe(1200);
    expect(fitted?.height).toBe(450);
    expect(fitted?.tiles[0]).toMatchObject({ left: 0, top: 0, width: 8 / 12 });
    expect(fitted?.tiles[1]).toMatchObject({ left: 8 / 12, height: 0.5 });
  });

  it("is undefined without items or room", () => {
    expect(fitSavedLayout([], 100, 100)).toBeUndefined();
    expect(
      fitSavedLayout([{ i: "a", x: 0, y: 0, w: 4, h: 4 }], 0, 100),
    ).toBeUndefined();
    expect(
      fitSavedLayout([{ i: "a", x: 0, y: 0, w: 0, h: 4 }], 100, 100),
    ).toBeUndefined();
  });
});

function segment(patch: Partial<ReviewSegment> = {}): ReviewSegment {
  return {
    id: "r1",
    camera: "garage",
    severity: "alert",
    start_time: 1_800_000_000,
    thumb_path: "/thumb.webp",
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: ["d1"],
      objects: ["person", "car", "person"],
      sub_labels: ["Justin"],
      significant_motion_areas: [],
      zones: [],
    },
    ...patch,
  };
}

function review(
  type: FrigateReview["type"],
  after: Partial<ReviewSegment> = {},
  before: Partial<ReviewSegment> = after,
): FrigateReview {
  return { type, before: segment(before), after: segment(after) };
}

describe("takeoverFromReview", () => {
  const shown = new Set(["garage", "front_door"]);
  const none = new Set<string>();

  it("takes over for a new alert on a shown camera", () => {
    expect(takeoverFromReview(review("new"), shown, none)).toEqual({
      reviewId: "r1",
      camera: "garage",
      objects: ["person", "car"],
      audio: [],
      subLabels: ["Justin"],
    });
  });

  it("takes over when a detection is upgraded to an alert", () => {
    expect(
      takeoverFromReview(
        review("update", {}, { severity: "detection" }),
        shown,
        none,
      )?.reviewId,
    ).toBe("r1");
  });

  it("takes over when the first message of an alert is an update", () => {
    // Frigate opens manual API and audio alerts without a "new" message
    const since = 1_800_000_000;
    expect(
      takeoverFromReview(review("update"), shown, none, since)?.reviewId,
    ).toBe("r1");
    expect(
      takeoverFromReview(
        review("update", { start_time: since - 1 }),
        shown,
        none,
        since,
      ),
    ).toBeUndefined();
    expect(
      takeoverFromReview(review("update"), shown, new Set(["r1"]), since),
    ).toBeUndefined();
  });

  it("drops verified labels and keeps audio", () => {
    const takeover = takeoverFromReview(
      review("new", {
        data: {
          audio: ["bark"],
          detections: [],
          objects: ["person-verified", "dog"],
          significant_motion_areas: [],
          zones: [],
        },
      }),
      shown,
      none,
    );
    expect(takeover).toMatchObject({
      objects: ["dog"],
      audio: ["bark"],
      subLabels: [],
    });
  });

  it.each([
    ["no message", undefined],
    ["a detection", review("new", { severity: "detection" })],
    ["an update to an alert", review("update")],
    ["an ended alert", review("end")],
    ["a description", review("genai")],
    ["a camera not on the display", review("new", { camera: "attic" })],
  ])("ignores %s", (_name, message) => {
    expect(takeoverFromReview(message, shown, none)).toBeUndefined();
  });

  it("takes over once per review", () => {
    expect(
      takeoverFromReview(review("new"), shown, new Set(["r1"])),
    ).toBeUndefined();
  });
});

function alert(
  reviewId: string,
  camera: string,
  patch: Partial<KioskTakeover> = {},
): KioskTakeover {
  return {
    reviewId,
    camera,
    objects: ["person"],
    audio: [],
    subLabels: [],
    ...patch,
  };
}

/** Queue alerts in order, the way the page does as messages arrive. */
function queued(...alerts: KioskTakeover[]): KioskTakeoverQueue {
  return alerts.reduce<KioskTakeoverQueue>(queueTakeover, []);
}

describe("queueTakeover", () => {
  it("lets alerts that start together take turns in arrival order", () => {
    const queue = queued(alert("a", "street"), alert("b", "lot"));
    expect(queue.map((entry) => entry.reviewId)).toEqual(["a", "b"]);
  });

  it("gives a review one turn however often it arrives", () => {
    const queue = queued(
      alert("a", "street"),
      alert("b", "lot"),
      alert("a", "street", { objects: ["car"] }),
      alert("b", "lot"),
    );
    expect(queue).toEqual([alert("a", "street"), alert("b", "lot")]);
    expect(queueTakeover(queue, alert("b", "lot"))).toBe(queue);
  });

  it("folds a newer alert into a camera that is already waiting", () => {
    const queue = queued(
      alert("a", "street"),
      alert("b", "lot"),
      alert("c", "door"),
      alert("d", "lot", {
        objects: ["car", "person"],
        audio: ["bark"],
        subLabels: ["ABC123"],
      }),
    );
    expect(queue).toEqual([
      alert("a", "street"),
      alert("d", "lot", {
        objects: ["person", "car"],
        audio: ["bark"],
        subLabels: ["ABC123"],
      }),
      alert("c", "door"),
    ]);
  });

  it("gives a new alert on the camera showing a turn of its own", () => {
    const queue = queued(
      alert("a", "street"),
      alert("b", "street", { objects: ["car"] }),
    );
    expect(queue).toEqual([
      alert("a", "street"),
      alert("b", "street", { objects: ["car"] }),
    ]);
  });
});

describe("dismissTakeover", () => {
  const queue = queued(alert("a", "street"), alert("b", "lot"));

  it("ends the turn of the alert showing and shows the next", () => {
    const next = dismissTakeover(queue, "a");
    expect(next.map((entry) => entry.reviewId)).toEqual(["b"]);
    expect(dismissTakeover(next, "b")).toEqual([]);
  });

  it("ignores a dismissal for an alert that is not showing", () => {
    // Esc and the timeout ending the same turn must not skip the next alert
    const next = dismissTakeover(queue, "a");
    expect(dismissTakeover(next, "a")).toBe(next);
    expect(dismissTakeover([], "a")).toEqual([]);
  });
});

describe("reviewFromPayload", () => {
  it("parses a reviews message", () => {
    const message = review("new");
    expect(reviewFromPayload(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    ["no payload", undefined],
    ["an object instead of JSON text", review("new")],
    ["broken JSON", "{"],
    ["JSON null", "null"],
    ["a message without a type", JSON.stringify({ before: {}, after: {} })],
    [
      "a segment without data",
      JSON.stringify({ ...review("new"), after: { id: "r1" } }),
    ],
  ])("rejects %s", (_name, payload) => {
    expect(reviewFromPayload(payload)).toBeUndefined();
  });
});

describe("tileStream", () => {
  const streams = { Main: "garage_main", Sub: "garage_sub" };

  it("uses the first stream and smart streaming by default", () => {
    expect(tileStream(streams, undefined, true, false)).toEqual({
      streamName: "garage_main",
      autoLive: true,
      showStillWithoutActivity: true,
      useWebGL: false,
    });
    expect(tileStream(streams, undefined, false, false).autoLive).toBe(false);
  });

  it("follows the group's streaming settings", () => {
    expect(
      tileStream(
        streams,
        {
          streamName: "garage_sub",
          streamType: "continuous",
          compatibilityMode: true,
        },
        false,
        false,
      ),
    ).toEqual({
      streamName: "garage_sub",
      autoLive: true,
      showStillWithoutActivity: false,
      useWebGL: true,
    });
    expect(
      tileStream(streams, { streamType: "no-streaming" }, true, false),
    ).toMatchObject({ autoLive: false, showStillWithoutActivity: true });
  });

  it("ignores a saved stream the camera no longer has", () => {
    expect(
      tileStream(streams, { streamName: "gone" }, true, false).streamName,
    ).toBe("garage_main");
    expect(tileStream({}, undefined, true, false).streamName).toBe("");
  });

  it("streams a camera alone on screen continuously", () => {
    expect(
      tileStream(streams, { streamType: "no-streaming" }, false, true),
    ).toEqual({
      streamName: "garage_main",
      autoLive: true,
      showStillWithoutActivity: false,
      useWebGL: false,
    });
  });
});

describe("fallbackLiveMode", () => {
  it("falls back like Live's dashboard", () => {
    expect(fallbackLiveMode("mse-decode", true)).toBe("webrtc");
    expect(fallbackLiveMode("mse-decode", false)).toBe("jsmpeg");
    expect(fallbackLiveMode("startup", true)).toBe("jsmpeg");
    expect(fallbackLiveMode("stalled", true)).toBe("jsmpeg");
  });
});

describe("keepAliveMs", () => {
  it("asks every 10 minutes with the default 30 minute refresh window", () => {
    expect(keepAliveMs({ enabled: true, refresh_time: 1800 })).toBe(600_000);
    expect(KEEP_ALIVE_MS).toBe(600_000);
  });

  it("asks twice per refresh window when the window is shorter", () => {
    expect(keepAliveMs({ enabled: true, refresh_time: 600 })).toBe(300_000);
    expect(keepAliveMs({ enabled: true, refresh_time: 30 })).toBe(15_000);
  });

  it("keeps the default when the config does not say", () => {
    expect(keepAliveMs(undefined)).toBe(KEEP_ALIVE_MS);
    expect(keepAliveMs({ enabled: true })).toBe(KEEP_ALIVE_MS);
    expect(keepAliveMs({ refresh_time: "1800" })).toBe(KEEP_ALIVE_MS);
    expect(keepAliveMs({ refresh_time: 0 })).toBe(KEEP_ALIVE_MS);
  });

  it("does not ask without authentication", () => {
    expect(keepAliveMs({ enabled: false, refresh_time: 1800 })).toBe(0);
  });
});
