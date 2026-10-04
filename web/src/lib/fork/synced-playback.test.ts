import { describe, expect, it } from "vitest";
import {
  clampSelection,
  clampSyncedRate,
  clockNow,
  decideTile,
  DRIFT_SEEK_S,
  fitBox,
  HOLD_GRACE_MS,
  isAtLiveEdge,
  isCoveredAt,
  LIVE_EDGE_S,
  MAX_HOLD_MS,
  mergeSpans,
  nextCoverageStart,
  NUDGE_MAX,
  pickDefaultCameras,
  pickGridLayout,
  planGapSkip,
  SEEK_COOLDOWN_MS,
  SEEK_LEAD_S,
  seekTarget,
  SYNCED_PLAYBACK_RATES,
  seekThreshold,
  shouldHold,
  sourceWindowStart,
  type SyncClock,
  type TileProbe,
  nudgedRate,
  updateClock,
} from "./synced-playback";

const span = (start_time: number, end_time: number) => ({
  start_time,
  end_time,
});

const probe = (patch: Partial<TileProbe> = {}): TileProbe => ({
  covered: true,
  hasVideo: true,
  ready: true,
  paused: false,
  drift: 0,
  sinceSeekMs: Infinity,
  notReadyMs: 0,
  joined: true,
  ...patch,
});

const PLAYING = { playing: true, holding: false, rate: 1 };
const PAUSED = { playing: false, holding: false, rate: 1 };
const HOLDING = { playing: true, holding: true, rate: 1 };

describe("coverage spans", () => {
  it("sorts spans and joins the ones closer than the tolerance", () => {
    expect(
      mergeSpans([span(20, 30), span(0, 10), span(10.5, 15), span(40, 50)]),
    ).toEqual([span(0, 15), span(20, 30), span(40, 50)]);
  });

  it("drops empty spans and keeps contained ones inside their parent", () => {
    expect(mergeSpans([span(5, 5), span(0, 30), span(10, 20)])).toEqual([
      span(0, 30),
    ]);
  });

  it("keeps gaps wider than a custom tolerance", () => {
    expect(mergeSpans([span(0, 10), span(10.5, 20)], 0)).toEqual([
      span(0, 10),
      span(10.5, 20),
    ]);
  });

  it("does not modify its input", () => {
    const input = [span(0, 10), span(10, 20)];
    mergeSpans(input);
    expect(input).toEqual([span(0, 10), span(10, 20)]);
  });

  it("treats a span as covering its start but not its end", () => {
    const spans = [span(10, 20)];
    expect(isCoveredAt(spans, 10)).toBe(true);
    expect(isCoveredAt(spans, 19.9)).toBe(true);
    expect(isCoveredAt(spans, 20)).toBe(false);
    expect(isCoveredAt(spans, 9)).toBe(false);
  });

  it("finds the next span start after a time", () => {
    const spans = [span(10, 20), span(40, 50)];
    expect(nextCoverageStart(spans, 0)).toBe(10);
    expect(nextCoverageStart(spans, 25)).toBe(40);
    expect(nextCoverageStart(spans, 45)).toBeUndefined();
  });
});

describe("isAtLiveEdge", () => {
  // the newest chunk of a view that ends at 7200
  const chunk = { after: 3600, before: 7200 };

  it("is the live edge when the camera recorded until just before the end", () => {
    const spans = [span(3600, 7200 - 20)];
    expect(isAtLiveEdge(spans, 7190, chunk, 7200)).toBe(true);
    expect(
      isAtLiveEdge([span(3600, 7200 - LIVE_EDGE_S)], 7190, chunk, 7200),
    ).toBe(true);
  });

  it("is not when the camera stopped well before the end", () => {
    expect(isAtLiveEdge([span(3600, 5000)], 7190, chunk, 7200)).toBe(false);
  });

  it("is not when more recording follows in the chunk", () => {
    expect(
      isAtLiveEdge([span(3600, 7150), span(7195, 7200)], 7160, chunk, 7200),
    ).toBe(false);
  });

  it("is not in an older chunk than the view's newest", () => {
    expect(isAtLiveEdge([span(3600, 7180)], 7190, chunk, 7230)).toBe(false);
  });

  it("counts a fresh chunk without saved footage yet", () => {
    const fresh = { after: 7200, before: 7230 };
    expect(isAtLiveEdge([], 7210, fresh, 7230)).toBe(true);
    const quiet = { after: 7200, before: 7200 + LIVE_EDGE_S * 2 };
    expect(isAtLiveEdge([], 7300, quiet, quiet.before)).toBe(false);
  });
});

describe("clampSyncedRate", () => {
  it("keeps a speed the grid offers", () => {
    for (const rate of SYNCED_PLAYBACK_RATES) {
      expect(clampSyncedRate(rate)).toBe(rate);
    }
  });

  it("plays the single player's 16x at the grid's fastest speed", () => {
    expect(clampSyncedRate(16)).toBe(8);
  });

  it("rounds an unlisted speed down and a very slow one up", () => {
    expect(clampSyncedRate(3)).toBe(2);
    expect(clampSyncedRate(0.25)).toBe(0.5);
  });
});

describe("planGapSkip", () => {
  it("does nothing while a camera records or coverage is loading", () => {
    expect(planGapSkip([[span(0, 100)], []], 50, 3600, 7200)).toEqual({
      kind: "none",
    });
    expect(planGapSkip([undefined, []], 50, 3600, 7200)).toEqual({
      kind: "none",
    });
    expect(planGapSkip([], 50, 3600, 7200)).toEqual({ kind: "none" });
  });

  it("jumps to the earliest recording any camera has next", () => {
    expect(
      planGapSkip(
        [[span(300, 400)], [span(0, 10), span(200, 260)]],
        100,
        3600,
        7200,
      ),
    ).toEqual({ kind: "seek", time: 200 });
  });

  it("ignores recordings past the chunk end", () => {
    expect(planGapSkip([[span(4000, 4100)]], 100, 3600, 7200)).toEqual({
      kind: "advance",
    });
  });

  it("stops at the end of the footage", () => {
    expect(planGapSkip([[span(0, 10)]], 100, 3600, 3600)).toEqual({
      kind: "end",
    });
  });
});

describe("the master clock", () => {
  const clock: SyncClock = {
    time: 1000,
    at: 0,
    playing: true,
    holding: false,
    rate: 2,
  };

  it("advances with the rate while playing", () => {
    expect(clockNow(clock, 1500)).toBe(1003);
  });

  it("stands still while paused or holding", () => {
    expect(clockNow({ ...clock, playing: false }, 5000)).toBe(1000);
    expect(clockNow({ ...clock, holding: true }, 5000)).toBe(1000);
  });

  it("re-anchors at a moment and applies a change", () => {
    const next = updateClock(clock, 1000, { rate: 1 });
    expect(next).toMatchObject({ time: 1002, at: 1000, rate: 1 });
    expect(clockNow(next, 2000)).toBe(1003);
  });

  it("keeps everything but the anchor without a change", () => {
    expect(updateClock(clock, 500)).toEqual({ ...clock, time: 1001, at: 500 });
  });
});

describe("drift helpers", () => {
  const chunk = { after: 3600, before: 7200 };

  it("mirrors the player's 10 second source grid", () => {
    expect(sourceWindowStart(3725, chunk)).toBe(3720);
    expect(sourceWindowStart(3601, chunk)).toBe(3600);
    expect(sourceWindowStart(100, chunk)).toBe(3600);
    expect(sourceWindowStart(undefined, chunk)).toBe(3600);
  });

  it("raises the seek threshold at high speed only", () => {
    expect(seekThreshold(1)).toBe(DRIFT_SEEK_S);
    expect(seekThreshold(2)).toBe(DRIFT_SEEK_S);
    expect(seekThreshold(8)).toBe(DRIFT_SEEK_S * 4);
  });

  it("aims a correcting seek ahead only while playing", () => {
    expect(seekTarget(100, true, 2)).toBeCloseTo(100 + SEEK_LEAD_S * 2);
    expect(seekTarget(100, false, 2)).toBe(100);
  });

  it("leaves small or unknown drift alone", () => {
    expect(nudgedRate(1, undefined)).toBe(1);
    expect(nudgedRate(1, 0.05)).toBe(1);
  });

  it("slows a tile that runs ahead and speeds one that lags", () => {
    expect(nudgedRate(1, 0.2)).toBeLessThan(1);
    expect(nudgedRate(1, -0.2)).toBeGreaterThan(1);
  });

  it("caps the change", () => {
    expect(nudgedRate(2, 10)).toBeCloseTo(2 * (1 - NUDGE_MAX));
    expect(nudgedRate(2, -10)).toBeCloseTo(2 * (1 + NUDGE_MAX));
  });
});

describe("decideTile", () => {
  it("parks a tile without recording", () => {
    expect(decideTile(probe({ covered: false }), PLAYING)).toEqual({
      kind: "gap",
    });
  });

  it("waits for a loading tile, pausing it if it runs on its own", () => {
    expect(decideTile(probe({ ready: false }), PLAYING)).toEqual({
      kind: "wait",
    });
    expect(decideTile(probe({ hasVideo: false }), HOLDING)).toEqual({
      kind: "pause",
    });
    expect(decideTile(probe({ ready: false, paused: true }), HOLDING)).toEqual({
      kind: "wait",
    });
  });

  it("pauses an aligned tile while the clock stands still", () => {
    expect(decideTile(probe({ drift: 0.1 }), PAUSED)).toEqual({
      kind: "pause",
    });
  });

  it("re-seeks a still tile that is off the master frame", () => {
    expect(decideTile(probe({ drift: 1 }), PAUSED)).toEqual({
      kind: "seek",
      play: false,
    });
    expect(decideTile(probe({ drift: undefined }), HOLDING)).toEqual({
      kind: "seek",
      play: false,
    });
  });

  it("does not seek again during the cooldown", () => {
    expect(
      decideTile(
        probe({ drift: 1, sinceSeekMs: SEEK_COOLDOWN_MS - 1 }),
        PAUSED,
      ),
    ).toEqual({ kind: "pause" });
    expect(
      decideTile(
        probe({ drift: 5, sinceSeekMs: SEEK_COOLDOWN_MS - 1 }),
        PLAYING,
      ),
    ).toEqual({ kind: "play", rate: nudgedRate(1, 5) });
  });

  it("seeks a playing tile past the threshold", () => {
    expect(decideTile(probe({ drift: -1 }), PLAYING)).toEqual({
      kind: "seek",
      play: true,
    });
  });

  it("nudges a playing tile with small drift", () => {
    expect(decideTile(probe({ drift: 0.3 }), PLAYING)).toEqual({
      kind: "play",
      rate: nudgedRate(1, 0.3),
    });
  });
});

describe("shouldHold", () => {
  it("never holds a paused clock", () => {
    expect(shouldHold([probe({ ready: false })], false, 0)).toBe(false);
  });

  it("waits after a command until every recording tile is ready and aligned", () => {
    expect(shouldHold([probe(), probe({ ready: false })], true, 0)).toBe(true);
    expect(shouldHold([probe({ hasVideo: false })], true, 0)).toBe(true);
    expect(shouldHold([probe({ drift: undefined })], true, 0)).toBe(true);
    expect(shouldHold([probe({ drift: 0.5 })], true, 0)).toBe(true);
    expect(shouldHold([probe({ drift: 0.1 })], true, 0)).toBe(false);
  });

  it("does not wait for a tile in a gap", () => {
    expect(shouldHold([probe({ covered: false, ready: false })], true, 0)).toBe(
      false,
    );
  });

  it("does not wait for a tile that never loaded", () => {
    expect(
      shouldHold(
        [probe({ ready: false, joined: false, notReadyMs: MAX_HOLD_MS })],
        true,
        0,
      ),
    ).toBe(false);
  });

  it("gives up the start-up wait after the limit", () => {
    expect(
      shouldHold([probe({ ready: false, joined: false })], true, MAX_HOLD_MS),
    ).toBe(false);
  });

  it("pauses the group for a buffering tile after the grace period", () => {
    const buffering = (notReadyMs: number) =>
      shouldHold([probe({ ready: false, notReadyMs })], true, undefined);

    expect(buffering(HOLD_GRACE_MS - 1)).toBe(false);
    expect(buffering(HOLD_GRACE_MS)).toBe(true);
    expect(buffering(MAX_HOLD_MS)).toBe(false);
  });

  it("ignores a buffering tile that never joined", () => {
    expect(
      shouldHold(
        [probe({ ready: false, joined: false, notReadyMs: 1000 })],
        true,
        undefined,
      ),
    ).toBe(false);
  });
});

describe("pickDefaultCameras", () => {
  const cameras = ["front", "back", "garage", "side", "street"];

  it("puts the main camera first, then the nearest activity", () => {
    expect(
      pickDefaultCameras({
        mainCamera: "back",
        cameras,
        time: 1000,
        activity: [
          { camera: "street", start_time: 1100, end_time: 1150 },
          { camera: "garage", start_time: 900, end_time: 1010 },
          { camera: "back", start_time: 990, end_time: 1000 },
          { camera: "side", start_time: 5000 },
          { camera: "unknown", start_time: 1000 },
        ],
      }),
    ).toEqual(["back", "garage", "street"]);
  });

  it("keeps a camera's nearest item and breaks ties in group order", () => {
    expect(
      pickDefaultCameras({
        mainCamera: "front",
        cameras,
        time: 1000,
        activity: [
          { camera: "side", start_time: 1100, end_time: null },
          { camera: "side", start_time: 1010, end_time: 1020 },
          { camera: "garage", start_time: 980, end_time: 990 },
        ],
      }),
    ).toEqual(["front", "garage", "side"]);
  });

  it("fills up to the minimum from the group when nothing happened", () => {
    expect(
      pickDefaultCameras({
        mainCamera: "garage",
        cameras,
        activity: [],
        time: 0,
      }),
    ).toEqual(["garage", "front"]);
  });

  it("stops at the maximum", () => {
    expect(
      pickDefaultCameras({
        mainCamera: "front",
        cameras,
        time: 0,
        max: 2,
        activity: cameras.map((camera) => ({ camera, start_time: 0 })),
      }),
    ).toEqual(["front", "back"]);
  });

  it("leaves out a main camera the group does not have", () => {
    expect(
      pickDefaultCameras({
        mainCamera: "attic",
        cameras: ["front", "back"],
        activity: [],
        time: 0,
      }),
    ).toEqual(["front", "back"]);
  });
});

describe("clampSelection", () => {
  it("drops repeats and unknown cameras and caps the count", () => {
    expect(
      clampSelection(["a", "b", "a", "x", "c", "d"], ["a", "b", "c", "d"], 3),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("layout", () => {
  it("fits a box by height in a wide area and by width in a tall one", () => {
    expect(fitBox(1000, 100, 2)).toEqual({ width: 200, height: 100 });
    expect(fitBox(100, 1000, 2)).toEqual({ width: 100, height: 50 });
  });

  it("returns an empty box for an unmeasured area or unknown aspect", () => {
    expect(fitBox(0, 100, 2)).toEqual({ width: 0, height: 0 });
    expect(fitBox(100, 100, Number.NaN)).toEqual({ width: 0, height: 0 });
  });

  it("uses one cell for one tile", () => {
    expect(pickGridLayout(1, 1000, 500)).toEqual({ cols: 1, rows: 1 });
  });

  it("puts two tiles side by side when wide and stacked when tall", () => {
    expect(pickGridLayout(2, 1400, 500)).toEqual({ cols: 2, rows: 1 });
    expect(pickGridLayout(2, 400, 450)).toEqual({ cols: 1, rows: 2 });
  });

  it("puts two tiles side by side on a 1440x900 desktop", () => {
    // stacked tiles would be 668x376, side by side 624x351: only 7% narrower
    expect(pickGridLayout(2, 1256, 760)).toEqual({ cols: 2, rows: 1 });
  });

  it("stacks two tiles on a phone in portrait", () => {
    expect(pickGridLayout(2, 412, 450)).toEqual({ cols: 1, rows: 2 });
    expect(pickGridLayout(2, 412, 410)).toEqual({ cols: 1, rows: 2 });
  });

  it("stacks two tiles when side by side would shrink them a lot", () => {
    // stacked 793x446 against 624x351 side by side
    expect(pickGridLayout(2, 1256, 900)).toEqual({ cols: 1, rows: 2 });
  });

  it("keeps a 2x2 for three or four tiles on a 1440x900 desktop", () => {
    expect(pickGridLayout(3, 1256, 760)).toEqual({ cols: 2, rows: 2 });
    expect(pickGridLayout(4, 1256, 760)).toEqual({ cols: 2, rows: 2 });
  });

  it("stacks every tile in a very tall area", () => {
    expect(pickGridLayout(4, 300, 3000)).toEqual({ cols: 1, rows: 4 });
  });

  it("makes a 2x2 for three or four tiles in a desktop area", () => {
    expect(pickGridLayout(3, 1400, 700)).toEqual({ cols: 2, rows: 2 });
    expect(pickGridLayout(4, 1400, 700)).toEqual({ cols: 2, rows: 2 });
  });

  it("lines four tiles up in a very wide area", () => {
    expect(pickGridLayout(4, 3000, 300)).toEqual({ cols: 4, rows: 1 });
  });

  it("falls back to columns of two before the area is measured", () => {
    expect(pickGridLayout(4, 0, 0)).toEqual({ cols: 2, rows: 2 });
  });
});
