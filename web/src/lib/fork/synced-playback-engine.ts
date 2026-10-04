/**
 * Fork (UI143): the master clock of the synced recording grid.
 *
 * Every tile is a DynamicVideoPlayer that follows this clock. `tick()` runs
 * a few times a second: it pauses tiles in a recording gap, starts the
 * group together once every recording tile has loaded, waits for a tile
 * that buffers, and pulls drifting tiles back with a small speed change or,
 * past a threshold, a seek. The decisions are the pure functions in
 * `synced-playback.ts`; this class keeps the state and applies them.
 *
 * The engine has the main player's controller surface, so the recording
 * view drives the grid (timeline seeks, scrubbing, the pause for a range
 * selection) exactly as it drives the single player.
 */

import type { DynamicVideoController } from "@/components/player/dynamic/DynamicVideoController";
import type { TimeRange } from "@/types/timeline";
import { playWithTemporaryMuteFallback } from "@/utils/videoUtil";
import {
  clockNow,
  decideTile,
  isAtLiveEdge,
  isCoveredAt,
  MAX_HOLD_MS,
  nextCoverageStart,
  planGapSkip,
  type PlaybackControllerLike,
  seekTarget,
  shouldHold,
  sourceWindowStart,
  type SyncClock,
  type TileAction,
  type TileProbe,
  type TimeSpan,
  updateClock,
} from "./synced-playback";

/** The recording video of a tile (the preview player has its own). */
export function findTileVideo(
  container: HTMLElement | null | undefined,
): HTMLVideoElement | null {
  return (
    container?.querySelector<HTMLVideoElement>(
      ".react-transform-component video",
    ) ?? null
  );
}

type TileController = Pick<
  DynamicVideoController,
  "pause" | "seekToTimestamp" | "scrubToTimestamp"
>;

type TileEntry = {
  controller?: TileController;
  container?: HTMLElement | null;
  /** Merged recording coverage of the chunk; undefined while loading. */
  spans: TimeSpan[] | undefined;
  /** A wall time the tile reported, with the media time it was at. */
  calib: { wall: number; media: number } | undefined;
  lastSeekAt: number;
  notReadySince: number | undefined;
  joined: boolean;
};

export type SyncedTileState = {
  gap: boolean;
  nextStart: number | undefined;
  /** The gap is only the newest footage, still being saved. */
  liveEdge: boolean;
};

export type SyncedPlaybackSnapshot = {
  /** Where the tiles' playlists start (their startTimestamp). */
  anchor: number;
  playing: boolean;
  /** The clock waits for tiles to load or catch up. */
  holding: boolean;
  tileStates: Record<string, SyncedTileState>;
  /** The main tile's video, for the volume control. */
  mainVideo: HTMLVideoElement | null;
};

export type SyncedPlaybackEngineOptions = {
  cameras: readonly string[];
  mainCamera: string;
  /** The hour chunk the players load. */
  timeRange: TimeRange;
  /** The end of the footage the view covers. */
  latestTime: number;
  isScrubbing: boolean;
  rate: number;
  muted: boolean;
};

export type SyncedPlaybackCallbacks = {
  onTimestampUpdate: (time: number) => void;
  onSeekToTime: (time: number, play?: boolean) => void;
  onClipEnded: () => void;
};

export type SyncedPlaybackEnvironment = {
  now: () => number;
  findVideo: (
    container: HTMLElement | null | undefined,
  ) => HTMLVideoElement | null;
  schedule: (task: () => void) => void;
};

const BROWSER: SyncedPlaybackEnvironment = {
  now: () => performance.now(),
  findVideo: findTileVideo,
  schedule: (task) => {
    setTimeout(task, 0);
  },
};

function safePlay(video: HTMLVideoElement) {
  // a pause on the next tick may interrupt this play; that is expected
  void playWithTemporaryMuteFallback(video).catch(() => undefined);
}

function sameTileStates(
  a: Record<string, SyncedTileState>,
  b: Record<string, SyncedTileState>,
) {
  // both are built in tile order, so the serializations line up
  return JSON.stringify(a) == JSON.stringify(b);
}

function newEntry(): TileEntry {
  return {
    spans: undefined,
    calib: undefined,
    lastSeekAt: -Infinity,
    notReadySince: undefined,
    joined: false,
  };
}

export class SyncedPlaybackEngine implements PlaybackControllerLike {
  options: SyncedPlaybackEngineOptions;
  callbacks: SyncedPlaybackCallbacks;

  private readonly env: SyncedPlaybackEnvironment;
  private readonly tiles = new Map<string, TileEntry>();
  private clock: SyncClock;
  /** Set by a master command; the clock then waits for the tiles. */
  private awaitingSince: number | undefined;
  /** The chunk end the engine asked the view to move past. */
  private advancedFrom: number | undefined;
  /** Since when the clock waits at a chunk end for the view. */
  private pendingChunkSince: number | undefined;
  private lastReported: number;
  private snapshot: SyncedPlaybackSnapshot;
  private readonly listeners = new Set<() => void>();
  /** Off while the grid is unmounted; a stale engine then does nothing. */
  private active = false;

  constructor(
    startTimestamp: number,
    options: SyncedPlaybackEngineOptions,
    callbacks: SyncedPlaybackCallbacks,
    env: Partial<SyncedPlaybackEnvironment> = {},
  ) {
    this.options = options;
    this.callbacks = callbacks;
    this.env = { ...BROWSER, ...env };

    const now = this.env.now();
    // the grid opens playing, like the single player, once tiles load
    this.clock = {
      time: startTimestamp,
      at: now,
      playing: true,
      holding: true,
      rate: options.rate,
    };
    this.awaitingSince = now;
    this.lastReported = startTimestamp;
    this.snapshot = {
      anchor: startTimestamp,
      playing: true,
      holding: true,
      tileStates: {},
      mainVideo: null,
    };
  }

  /** The published state; a new object whenever any of it changes. */
  getSnapshot = (): SyncedPlaybackSnapshot => this.snapshot;

  /** For useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The master time now. */
  currentTime(): number {
    return clockNow(this.clock, this.env.now());
  }

  // controller surface (see PlaybackControllerLike)

  play() {
    if (this.clock.playing) {
      return;
    }

    const now = this.env.now();
    this.clock = updateClock(this.clock, now, {
      playing: true,
      holding: true,
    });
    this.awaitingSince = now;
    this.tickSoon();
  }

  pause() {
    this.clock = updateClock(this.clock, this.env.now(), {
      playing: false,
      holding: false,
    });
    this.awaitingSince = undefined;
    this.tiles.forEach((entry) => entry.controller?.pause());
    this.tickSoon();
  }

  isPlaying(): boolean {
    return this.clock.playing;
  }

  seekToTimestamp(time: number, play: boolean = false) {
    this.seekAll(time, play, true);
    this.tickSoon();
  }

  scrubToTimestamp(time: number) {
    this.clock = {
      ...this.clock,
      time,
      at: this.env.now(),
      playing: false,
      holding: false,
    };
    this.awaitingSince = undefined;
    this.pendingChunkSince = undefined;
    this.lastReported = time;
    this.tiles.forEach((entry) => entry.controller?.scrubToTimestamp(time));
  }

  // grid commands

  /** Steps every tile by `diff` seconds, keeping the play state. */
  step(diff: number) {
    this.jumpTo(this.currentTime() + diff, this.clock.playing);
    this.tickSoon();
  }

  setRate(rate: number) {
    if (rate == this.clock.rate) {
      return;
    }

    this.clock = updateClock(this.clock, this.env.now(), { rate });
    this.tickSoon();
  }

  /**
   * A new hour chunk reloads every tile, so the clock waits for them again.
   * A seek into another chunk set the view's playback start inside it, and
   * the grid resumes there playing, as the single player does. A natural
   * advance left the start behind; the clock then goes on from the chunk
   * boundary it waited at.
   */
  chunkChanged(startTimestamp: number) {
    const { timeRange, isScrubbing } = this.options;
    const now = this.env.now();
    const seeked =
      startTimestamp >= timeRange.after && startTimestamp <= timeRange.before;

    this.pendingChunkSince = undefined;
    this.advancedFrom = undefined;
    this.setAnchor(startTimestamp);

    if (seeked) {
      this.clock = {
        ...this.clock,
        time: startTimestamp,
        at: now,
        playing: !isScrubbing,
        holding: !isScrubbing,
      };
      this.lastReported = startTimestamp;
    } else {
      const time = Math.min(
        Math.max(clockNow(this.clock, now), timeRange.after),
        timeRange.before,
      );
      this.clock = {
        ...this.clock,
        time,
        at: now,
        holding: this.clock.playing,
      };
    }

    this.awaitingSince = this.clock.playing ? now : undefined;
    this.tiles.forEach((entry) => {
      entry.calib = undefined;
      entry.lastSeekAt = -Infinity;
    });
    this.tickSoon();
  }

  // tiles

  registerTile(
    camera: string,
    tile: { controller?: TileController; container?: HTMLElement | null },
  ) {
    const entry = this.tiles.get(camera) ?? newEntry();

    if (tile.controller) {
      entry.controller = tile.controller;
    }
    if (tile.container !== undefined) {
      entry.container = tile.container;
    }
    this.tiles.set(camera, entry);
  }

  unregisterTile(camera: string) {
    this.tiles.delete(camera);
  }

  setTileCoverage(camera: string, spans: TimeSpan[] | undefined) {
    const entry = this.tiles.get(camera) ?? newEntry();
    entry.spans = spans;
    this.tiles.set(camera, entry);
  }

  /** A tile played `wall`; pairs it with its media time to measure drift. */
  reportTileTime(camera: string, wall: number) {
    const entry = this.tiles.get(camera);
    const video = this.env.findVideo(entry?.container);

    if (entry && video) {
      entry.calib = { wall, media: video.currentTime };
    }
  }

  // the loop

  /** Starts the sync loop; returns the function that stops it. */
  start(intervalMs: number): () => void {
    this.active = true;
    const id = setInterval(() => this.tick(), intervalMs);

    return () => {
      this.active = false;
      clearInterval(id);
    };
  }

  tick() {
    if (!this.active) {
      return;
    }

    const now = this.env.now();

    if (this.options.isScrubbing || this.waitingForChunk(now)) {
      this.publish(this.clock.time);
      return;
    }

    if (this.followGaps(now)) {
      return;
    }

    const time = clockNow(this.clock, now);
    const probed = this.options.cameras.map((camera) => {
      const entry = this.tiles.get(camera);
      return { camera, entry, probe: this.probe(entry, time, now) };
    });
    this.updateHold(
      probed.map(({ probe }) => probe),
      now,
    );
    this.reconcile(probed, clockNow(this.clock, now), now);
  }

  /** While the view loads the next chunk the clock stays at the boundary. */
  private waitingForChunk(now: number): boolean {
    if (this.pendingChunkSince === undefined) {
      return false;
    }

    if (now - this.pendingChunkSince < MAX_HOLD_MS) {
      return true;
    }

    // the view never moved on to another chunk: stop at the boundary
    this.pendingChunkSince = undefined;
    this.clock = updateClock(this.clock, now, {
      playing: false,
      holding: false,
    });
    return false;
  }

  /**
   * Skips gaps every camera shares and moves past the chunk end. Returns
   * true when it handed the tick over to a seek or a chunk change.
   */
  private followGaps(now: number): boolean {
    const { cameras, timeRange, latestTime } = this.options;

    if (!this.clock.playing) {
      return false;
    }

    const time = clockNow(this.clock, now);
    const plan = planGapSkip(
      cameras.map((camera) => this.tiles.get(camera)?.spans),
      time,
      timeRange.before,
      latestTime,
    );
    const running = !this.clock.holding;

    if (running && plan.kind == "seek") {
      this.jumpTo(plan.time, true);
      return true;
    }

    const atEnd =
      time >= timeRange.before || (running && plan.kind == "advance");

    if (
      atEnd &&
      timeRange.before < latestTime &&
      this.advancedFrom !== timeRange.before
    ) {
      // the view loads the next hour; the clock waits at the boundary
      this.advancedFrom = timeRange.before;
      this.pendingChunkSince = now;
      this.clock = {
        ...this.clock,
        time: timeRange.before,
        at: now,
        holding: true,
      };
      this.callbacks.onClipEnded();
      this.publish(timeRange.before);
      this.report(timeRange.before);
      return true;
    }

    if (atEnd || (running && plan.kind == "end")) {
      // nothing left to play: stop at the last footage
      this.clock = updateClock(this.clock, now, {
        time: Math.min(time, timeRange.before),
        playing: false,
        holding: false,
      });
      this.awaitingSince = undefined;
    }

    return false;
  }

  private updateHold(probes: TileProbe[], now: number) {
    const awaiting =
      this.awaitingSince === undefined ? undefined : now - this.awaitingSince;
    const hold = shouldHold(probes, this.clock.playing, awaiting);

    if (!hold) {
      this.awaitingSince = undefined;
    }

    if (hold != this.clock.holding) {
      this.clock = updateClock(this.clock, now, { holding: hold });
    }
  }

  private reconcile(
    probed: {
      camera: string;
      entry: TileEntry | undefined;
      probe: TileProbe;
    }[],
    time: number,
    now: number,
  ) {
    const master = {
      playing: this.clock.playing,
      holding: this.clock.holding,
      rate: this.clock.rate,
    };

    for (const { camera, entry, probe } of probed) {
      if (entry) {
        const video = this.env.findVideo(entry.container);
        this.apply(entry, video, decideTile(probe, master), time, now);
        this.syncMute(camera, video);
      }
    }

    this.publish(time);
    this.report(time);
  }

  /** Applies the grid's mute state now (the loop also keeps it). */
  applyMutes() {
    for (const camera of this.options.cameras) {
      this.syncMute(
        camera,
        this.env.findVideo(this.tiles.get(camera)?.container),
      );
    }
  }

  /** Audio follows the main tile only. */
  private syncMute(camera: string, video: HTMLVideoElement | null) {
    const muted = this.options.muted || camera != this.options.mainCamera;

    if (video && video.muted != muted) {
      video.muted = muted;
    }
  }

  private apply(
    entry: TileEntry,
    video: HTMLVideoElement | null,
    action: TileAction,
    time: number,
    now: number,
  ) {
    switch (action.kind) {
      case "gap":
      case "pause":
        if (video && !video.paused) {
          video.pause();
        }
        break;
      case "seek":
        this.seekTile(
          entry,
          video,
          seekTarget(time, action.play, this.clock.rate),
          action.play,
          now,
        );
        break;
      case "play":
        if (video) {
          if (Math.abs(video.playbackRate - action.rate) > 0.001) {
            video.playbackRate = action.rate;
          }
          if (video.paused) {
            safePlay(video);
          }
        }
        break;
      case "wait":
        break;
    }
  }

  private seekTile(
    entry: TileEntry,
    video: HTMLVideoElement | null,
    target: number,
    play: boolean,
    now: number,
  ) {
    entry.lastSeekAt = now;
    entry.calib = undefined;
    entry.controller?.seekToTimestamp(target, false);

    if (play && video) {
      // resume the moment the seek lands instead of a tick later
      video.addEventListener(
        "seeked",
        () => {
          if (
            entry.lastSeekAt == now &&
            this.clock.playing &&
            !this.clock.holding
          ) {
            safePlay(video);
          }
        },
        { once: true },
      );
    }
  }

  /** Moves the clock and every tile to `time`; the group then restarts. */
  private seekAll(time: number, play: boolean, moveAnchor: boolean) {
    const now = this.env.now();

    this.clock = {
      ...this.clock,
      time,
      at: now,
      playing: play,
      holding: play,
    };
    this.awaitingSince = play ? now : undefined;
    this.lastReported = time;
    this.advancedFrom = undefined;
    this.pendingChunkSince = undefined;

    if (moveAnchor) {
      this.setAnchor(time);
    }

    for (const camera of this.options.cameras) {
      const entry = this.tiles.get(camera);

      if (!entry?.controller) {
        continue;
      }

      entry.lastSeekAt = now;
      entry.calib = undefined;

      if (!entry.spans || isCoveredAt(entry.spans, time)) {
        entry.controller.seekToTimestamp(time, false);
      } else {
        entry.controller.pause();
      }
    }
  }

  /** A seek the grid starts itself (steps, gap skips). */
  private jumpTo(time: number, play: boolean) {
    const { timeRange, latestTime } = this.options;
    const target = Math.min(time, latestTime);

    // inside the loaded playlists the tiles seek in place; anything else
    // goes through the view, which moves the chunk and the anchor
    if (
      target >= sourceWindowStart(this.snapshot.anchor, timeRange) &&
      target <= timeRange.before
    ) {
      this.seekAll(target, play, false);
      this.callbacks.onTimestampUpdate(target);
    } else {
      this.callbacks.onSeekToTime(target, play);
    }
  }

  private probe(
    entry: TileEntry | undefined,
    time: number,
    now: number,
  ): TileProbe {
    if (!entry) {
      return {
        covered: true,
        hasVideo: false,
        ready: false,
        paused: true,
        drift: undefined,
        sinceSeekMs: Infinity,
        notReadyMs: 0,
        joined: false,
      };
    }

    const video = this.env.findVideo(entry.container);
    const hasVideo = !!video && !!entry.controller;
    const ready =
      hasVideo &&
      video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
      !video.seeking;

    if (ready) {
      entry.notReadySince = undefined;
      entry.joined = true;
    } else {
      entry.notReadySince ??= now;
    }

    return {
      covered: entry.spans === undefined || isCoveredAt(entry.spans, time),
      hasVideo,
      ready,
      paused: video?.paused ?? true,
      drift:
        ready && entry.calib
          ? entry.calib.wall + (video.currentTime - entry.calib.media) - time
          : undefined,
      sinceSeekMs: now - entry.lastSeekAt,
      notReadyMs:
        entry.notReadySince === undefined ? 0 : now - entry.notReadySince,
      joined: entry.joined,
    };
  }

  private setAnchor(anchor: number) {
    if (anchor != this.snapshot.anchor) {
      this.snapshot = { ...this.snapshot, anchor };
      this.emit();
    }
  }

  private publish(time: number) {
    const { cameras, mainCamera, timeRange, latestTime } = this.options;
    const tileStates: Record<string, SyncedTileState> = {};

    for (const camera of cameras) {
      const spans = this.tiles.get(camera)?.spans;
      const gap = spans !== undefined && !isCoveredAt(spans, time);
      tileStates[camera] = {
        gap,
        nextStart: gap ? nextCoverageStart(spans, time) : undefined,
        liveEdge: gap && isAtLiveEdge(spans, time, timeRange, latestTime),
      };
    }

    const mainVideo = this.env.findVideo(this.tiles.get(mainCamera)?.container);
    const prev = this.snapshot;

    if (
      prev.playing == this.clock.playing &&
      prev.holding == this.clock.holding &&
      prev.mainVideo === mainVideo &&
      sameTileStates(prev.tileStates, tileStates)
    ) {
      return;
    }

    this.snapshot = {
      anchor: prev.anchor,
      playing: this.clock.playing,
      holding: this.clock.holding,
      tileStates: sameTileStates(prev.tileStates, tileStates)
        ? prev.tileStates
        : tileStates,
      mainVideo,
    };
    this.emit();
  }

  private report(time: number) {
    if (Math.abs(time - this.lastReported) >= 0.05) {
      this.lastReported = time;
      this.callbacks.onTimestampUpdate(time);
    }
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  private tickSoon() {
    this.env.schedule(() => this.tick());
  }
}
