import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import {
  findTileVideo,
  SyncedPlaybackEngine,
  type SyncedPlaybackEngineOptions,
} from "./synced-playback-engine";
import { MAX_HOLD_MS, SEEK_COOLDOWN_MS, SEEK_LEAD_S } from "./synced-playback";

// a chunk of one hour; tile media time 0 is the chunk start
const CHUNK = { after: 3600, before: 7200 };

class FakeVideo {
  currentTime = 0;
  paused = true;
  readyState = 4;
  seeking = false;
  muted = true;
  playbackRate = 1;
  private listeners = new Map<string, (() => void)[]>();

  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });

  pause = vi.fn(() => {
    this.paused = true;
  });

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.delete(type);
    listeners.forEach((listener) => listener());
  }
}

type Tile = {
  video: FakeVideo;
  container: HTMLElement;
  controller: {
    pause: Mock<() => void>;
    seekToTimestamp: Mock<(time: number, play?: boolean) => void>;
    scrubToTimestamp: Mock<(time: number) => void>;
  };
};

let now = 0;
let videos: Map<HTMLElement, FakeVideo>;
let callbacks: {
  onTimestampUpdate: Mock<(time: number) => void>;
  onSeekToTime: Mock<(time: number, play?: boolean) => void>;
  onClipEnded: Mock<() => void>;
};
let stop: (() => void) | undefined;

function makeEngine(
  patch: Partial<SyncedPlaybackEngineOptions> = {},
  start = 4000,
) {
  const engine = new SyncedPlaybackEngine(
    start,
    {
      cameras: ["front", "back"],
      mainCamera: "front",
      timeRange: CHUNK,
      latestTime: 10800,
      isScrubbing: false,
      rate: 1,
      muted: false,
      ...patch,
    },
    callbacks,
    {
      now: () => now,
      findVideo: (container) =>
        ((container && videos.get(container)) ??
          null) as HTMLVideoElement | null,
      schedule: () => undefined,
    },
  );
  stop = engine.start(60_000);
  return engine;
}

function addTile(
  engine: SyncedPlaybackEngine,
  camera: string,
  spans?: { start_time: number; end_time: number }[],
): Tile {
  const video = new FakeVideo();
  const container = document.createElement("div");
  videos.set(container, video);
  const controller = {
    pause: vi.fn(() => video.pause()),
    seekToTimestamp: vi.fn((time: number, _play?: boolean) => {
      video.currentTime = time - CHUNK.after;
      video.pause();
    }),
    scrubToTimestamp: vi.fn<(time: number) => void>(),
  };
  engine.registerTile(camera, { controller, container });
  engine.setTileCoverage(camera, spans ?? [{ start_time: 0, end_time: 1e9 }]);
  return { video, container, controller };
}

/** The tile reports its position, as its player does on timeupdate. */
function report(engine: SyncedPlaybackEngine, camera: string, tile: Tile) {
  engine.reportTileTime(camera, tile.video.currentTime + CHUNK.after);
}

function at(tile: Tile, time: number) {
  tile.video.currentTime = time - CHUNK.after;
}

/** Brings both tiles to the start and lets the group begin playing. */
function startTogether(engine: SyncedPlaybackEngine, tiles: [string, Tile][]) {
  for (const [camera, tile] of tiles) {
    at(tile, engine.currentTime());
    report(engine, camera, tile);
  }
  engine.tick();
}

beforeEach(() => {
  now = 0;
  videos = new Map();
  callbacks = {
    onTimestampUpdate: vi.fn<(time: number) => void>(),
    onSeekToTime: vi.fn<(time: number, play?: boolean) => void>(),
    onClipEnded: vi.fn<() => void>(),
  };
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("findTileVideo", () => {
  it("finds the recording video, not the preview one", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<video class="preview"></video><div class="react-transform-component"><video class="main"></video></div>';
    expect(findTileVideo(container)?.className).toBe("main");
    expect(findTileVideo(null)).toBeNull();
  });
});

describe("SyncedPlaybackEngine", () => {
  it("waits for every tile before the group starts", () => {
    const engine = makeEngine();
    const front = addTile(engine, "front");
    const back = addTile(engine, "back");
    back.video.readyState = 1;
    front.video.paused = false;

    at(front, 4000);
    report(engine, "front", front);
    engine.tick();

    expect(engine.getSnapshot()).toMatchObject({
      playing: true,
      holding: true,
    });
    // the loaded tile may not run ahead of the one still loading
    expect(front.video.pause).toHaveBeenCalled();

    now = 1000;
    engine.tick();
    expect(engine.currentTime()).toBe(4000);

    back.video.readyState = 4;
    at(back, 4000);
    report(engine, "back", back);
    engine.tick();

    expect(engine.getSnapshot().holding).toBe(false);
    expect(front.video.play).toHaveBeenCalled();
    expect(back.video.play).toHaveBeenCalled();

    now = 3000;
    expect(engine.currentTime()).toBe(4002);
  });

  it("aligns a still tile that is off the master frame with a seek", () => {
    const engine = makeEngine();
    const front = addTile(engine, "front");
    const back = addTile(engine, "back");
    at(front, 4000);
    report(engine, "front", front);
    at(back, 4003);
    report(engine, "back", back);

    engine.tick();

    expect(back.controller.seekToTimestamp).toHaveBeenCalledWith(4000, false);
    expect(front.controller.seekToTimestamp).not.toHaveBeenCalled();
    expect(engine.getSnapshot().holding).toBe(true);
  });

  it("nudges a drifting tile and seeks one that is far off", () => {
    const engine = makeEngine();
    const front = addTile(engine, "front");
    const back = addTile(engine, "back");
    startTogether(engine, [
      ["front", front],
      ["back", back],
    ]);

    now = 2000;
    at(front, 4002);
    report(engine, "front", front);
    at(back, 4002.3);
    report(engine, "back", back);
    engine.tick();

    expect(front.video.playbackRate).toBe(1);
    expect(back.video.playbackRate).toBeLessThan(1);

    now = 4000;
    at(front, 4004);
    report(engine, "front", front);
    at(back, 4002);
    report(engine, "back", back);
    engine.tick();

    expect(back.controller.seekToTimestamp).toHaveBeenLastCalledWith(
      4004 + SEEK_LEAD_S,
      false,
    );

    // the seek resumes the tile as soon as it lands
    back.video.pause();
    back.video.play.mockClear();
    back.video.emit("seeked");
    expect(back.video.play).toHaveBeenCalled();

    // and the tile is not seeked again while the seek settles
    back.controller.seekToTimestamp.mockClear();
    now = 4000 + SEEK_COOLDOWN_MS / 2;
    at(back, 4001);
    report(engine, "back", back);
    engine.tick();
    expect(back.controller.seekToTimestamp).not.toHaveBeenCalled();
  });

  it("parks a tile in a recording gap without stopping the others", () => {
    const engine = makeEngine();
    const front = addTile(engine, "front");
    const back = addTile(engine, "back", [
      { start_time: 3600, end_time: 3900 },
      { start_time: 4100, end_time: 7200 },
    ]);
    startTogether(engine, [["front", front]]);
    back.video.paused = false;
    engine.tick();

    expect(engine.getSnapshot().holding).toBe(false);
    expect(back.video.pause).toHaveBeenCalled();
    expect(engine.getSnapshot().tileStates).toEqual({
      front: { gap: false, liveEdge: false },
      back: { gap: true, nextStart: 4100, liveEdge: false },
    });
  });

  it("tells a tile caught up with the live edge from one out of footage", () => {
    // the newest chunk; back's last segment is not saved yet, side stopped
    const engine = makeEngine(
      { cameras: ["front", "back", "side"], latestTime: 7200 },
      7175,
    );
    const front = addTile(engine, "front", [
      { start_time: 3600, end_time: 7190 },
    ]);
    addTile(engine, "back", [{ start_time: 3600, end_time: 7170 }]);
    addTile(engine, "side", [{ start_time: 3600, end_time: 5000 }]);
    startTogether(engine, [["front", front]]);

    expect(engine.getSnapshot().tileStates).toEqual({
      front: { gap: false, liveEdge: false },
      back: { gap: true, liveEdge: true },
      side: { gap: true, liveEdge: false },
    });

    // the clock stops where the saved footage ends, not in the future
    now = 20_000;
    engine.tick();
    expect(engine.isPlaying()).toBe(false);
    expect(engine.currentTime()).toBeLessThan(7200);
    expect(engine.getSnapshot().tileStates).toEqual({
      front: { gap: true, liveEdge: true },
      back: { gap: true, liveEdge: true },
      side: { gap: true, liveEdge: false },
    });
  });

  it("keeps the out-of-footage card before the view's newest chunk", () => {
    const engine = makeEngine({ cameras: ["front", "back"] }, 7175);
    const front = addTile(engine, "front");
    addTile(engine, "back", [{ start_time: 3600, end_time: 7170 }]);
    startTogether(engine, [["front", front]]);

    expect(engine.getSnapshot().tileStates).toEqual({
      front: { gap: false, liveEdge: false },
      back: { gap: true, liveEdge: false },
    });
  });

  it("skips a gap every camera shares", () => {
    const spans = [
      { start_time: 3600, end_time: 3990 },
      { start_time: 4200, end_time: 7200 },
    ];
    const engine = makeEngine({}, 3995);
    const front = addTile(engine, "front", spans);
    const back = addTile(engine, "back", spans);
    engine.tick();
    engine.tick();

    expect(callbacks.onTimestampUpdate).toHaveBeenCalledWith(4200);
    expect(front.controller.seekToTimestamp).toHaveBeenCalledWith(4200, false);
    expect(back.controller.seekToTimestamp).toHaveBeenCalledWith(4200, false);
  });

  it("hands the next hour over to the view at the chunk end", () => {
    const engine = makeEngine({}, 7199);
    const front = addTile(engine, "front");
    const back = addTile(engine, "back");
    startTogether(engine, [
      ["front", front],
      ["back", back],
    ]);

    now = 2000;
    engine.tick();
    engine.tick();

    expect(callbacks.onClipEnded).toHaveBeenCalledTimes(1);
    expect(callbacks.onTimestampUpdate).toHaveBeenLastCalledWith(7200);

    // the view moves to the next chunk; the start it had is now behind
    engine.options = {
      ...engine.options,
      timeRange: { after: 7200, before: 10800 },
    };
    engine.chunkChanged(4000);

    expect(engine.currentTime()).toBe(7200);
    expect(engine.getSnapshot()).toMatchObject({
      anchor: 4000,
      playing: true,
      holding: true,
    });
  });

  it("stops at the chunk end when the view never moves on", () => {
    const engine = makeEngine({ cameras: ["front"] }, 7199.9);
    const front = addTile(engine, "front");
    startTogether(engine, [["front", front]]);
    now = 1000;
    engine.tick();
    expect(callbacks.onClipEnded).toHaveBeenCalled();

    now = 1000 + MAX_HOLD_MS;
    engine.tick();
    expect(engine.isPlaying()).toBe(false);
    expect(engine.currentTime()).toBe(7200);
  });

  it("stops at the end of the footage", () => {
    const engine = makeEngine({ latestTime: 7200 }, 7199);
    const front = addTile(engine, "front");
    const back = addTile(engine, "back");
    startTogether(engine, [
      ["front", front],
      ["back", back],
    ]);

    now = 3000;
    engine.tick();

    expect(callbacks.onClipEnded).not.toHaveBeenCalled();
    expect(engine.isPlaying()).toBe(false);
    expect(engine.currentTime()).toBe(7200);
  });

  it("resumes where a seek into another chunk landed", () => {
    const engine = makeEngine();
    addTile(engine, "front");
    engine.pause();
    engine.options = {
      ...engine.options,
      timeRange: { after: 7200, before: 10800 },
    };
    engine.chunkChanged(8000);

    expect(engine.currentTime()).toBe(8000);
    expect(engine.getSnapshot().anchor).toBe(8000);
    expect(engine.isPlaying()).toBe(true);
  });

  it("stays paused when the chunk changes during a drag", () => {
    const engine = makeEngine({ isScrubbing: true });
    engine.options = {
      ...engine.options,
      timeRange: { after: 7200, before: 10800 },
    };
    engine.chunkChanged(8000);
    expect(engine.isPlaying()).toBe(false);
  });

  it("seeks every recording tile and parks the rest", () => {
    const engine = makeEngine();
    const front = addTile(engine, "front");
    const back = addTile(engine, "back", [
      { start_time: 3600, end_time: 4000 },
    ]);
    const listener = vi.fn();
    engine.subscribe(listener);

    engine.seekToTimestamp(5000, true);

    expect(front.controller.seekToTimestamp).toHaveBeenCalledWith(5000, false);
    expect(back.controller.pause).toHaveBeenCalled();
    expect(engine.getSnapshot().anchor).toBe(5000);
    expect(listener).toHaveBeenCalled();
    expect(engine.isPlaying()).toBe(true);
  });

  it("pauses, plays and scrubs the whole group", () => {
    const engine = makeEngine();
    const front = addTile(engine, "front");
    const back = addTile(engine, "back");

    engine.pause();
    expect(engine.isPlaying()).toBe(false);
    expect(front.controller.pause).toHaveBeenCalled();
    expect(back.controller.pause).toHaveBeenCalled();

    engine.play();
    expect(engine.isPlaying()).toBe(true);
    expect(engine.getSnapshot().holding).toBe(true);

    engine.scrubToTimestamp(4500);
    expect(engine.isPlaying()).toBe(false);
    expect(engine.currentTime()).toBe(4500);
    expect(back.controller.scrubToTimestamp).toHaveBeenCalledWith(4500);
  });

  it("leaves the tiles alone while the timeline is dragged", () => {
    const engine = makeEngine({ isScrubbing: true });
    const front = addTile(engine, "front");
    front.video.readyState = 1;
    front.video.paused = false;
    engine.tick();
    expect(front.video.pause).not.toHaveBeenCalled();
  });

  it("steps inside the loaded playlists and asks the view otherwise", () => {
    const engine = makeEngine();
    const front = addTile(engine, "front");
    engine.pause();

    engine.step(10);
    expect(front.controller.seekToTimestamp).toHaveBeenLastCalledWith(
      4010,
      false,
    );
    expect(callbacks.onTimestampUpdate).toHaveBeenLastCalledWith(4010);

    // the playlists start at 4000, so earlier needs a new source
    engine.step(-60);
    expect(callbacks.onSeekToTime).toHaveBeenCalledWith(3950, false);
  });

  it("changes speed without a jump", () => {
    const engine = makeEngine();
    const front = addTile(engine, "front");
    const back = addTile(engine, "back");
    startTogether(engine, [
      ["front", front],
      ["back", back],
    ]);

    now = 1000;
    engine.setRate(2);
    engine.setRate(2);
    now = 2000;
    expect(engine.currentTime()).toBe(4003);
  });

  it("plays only the main tile's audio", () => {
    const engine = makeEngine();
    const front = addTile(engine, "front");
    const back = addTile(engine, "back");
    back.video.muted = false;

    engine.applyMutes();
    expect(front.video.muted).toBe(false);
    expect(back.video.muted).toBe(true);

    engine.options = { ...engine.options, mainCamera: "back" };
    engine.applyMutes();
    expect(front.video.muted).toBe(true);
    expect(back.video.muted).toBe(false);

    engine.options = { ...engine.options, muted: true };
    engine.applyMutes();
    expect(back.video.muted).toBe(true);
  });

  it("publishes the main video and only real changes", () => {
    const engine = makeEngine();
    const front = addTile(engine, "front");
    addTile(engine, "back");
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);

    engine.tick();
    expect(engine.getSnapshot().mainVideo).toBe(front.video);
    const calls = listener.mock.calls.length;
    const snapshot = engine.getSnapshot();

    engine.tick();
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(engine.getSnapshot()).toBe(snapshot);

    unsubscribe();
    engine.pause();
    engine.tick();
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("does nothing once stopped or for a removed tile", () => {
    const engine = makeEngine();
    const front = addTile(engine, "front");
    engine.unregisterTile("front");
    engine.reportTileTime("front", 4000);
    front.video.paused = false;
    engine.tick();
    expect(front.video.pause).not.toHaveBeenCalled();

    const back = addTile(engine, "back");
    back.video.paused = false;
    stop?.();
    stop = undefined;
    engine.tick();
    expect(back.video.pause).not.toHaveBeenCalled();
  });
});
