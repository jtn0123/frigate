import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrigateStats } from "@/types/stats";

const fixture = vi.hoisted(() => ({
  stats: undefined as FrigateStats | undefined,
}));
vi.mock("@/hooks/use-stats", () => ({
  useAutoFrigateStats: () => fixture.stats,
}));

import { useAutoLiveStream } from "./use-auto-live-stream";

let cameraIndex = 0;

// governors live for the tab session, so each test gets its own camera
function setup(selected = true, paused = false) {
  const cameraName = `cam_${cameraIndex++}`;
  const streams = [`${cameraName}_main`, `${cameraName}_sub`];
  const hook = renderHook(
    (props: { selected: boolean; paused: boolean }) =>
      useAutoLiveStream({ cameraName, streams, ...props }),
    { initialProps: { selected, paused } },
  );
  return { ...hook, streams, cameraName };
}

beforeEach(() => {
  fixture.stats = undefined;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useAutoLiveStream", () => {
  it("plays the top stream and steps down on a stall", () => {
    const { result, streams } = setup();
    expect(result.current.streamName).toBe(streams[0]);

    act(() => {
      expect(result.current.handleError("stalled")).toBe(true);
    });
    expect(result.current.streamName).toBe(streams[1]);
    expect(result.current.reason).toBe("bandwidth");

    act(() => {
      result.current.handleError("stalled");
    });
    // the floor keeps the last stream for jsmpeg
    expect(result.current.atFloor).toBe(true);
    expect(result.current.streamName).toBe(streams[1]);

    act(() => result.current.reset());
    expect(result.current.streamName).toBe(streams[0]);
  });

  it("reports nothing and handles nothing when auto is not selected", () => {
    const { result } = setup(false);
    expect(result.current.streamName).toBeUndefined();
    expect(result.current.reason).toBeUndefined();
    expect(result.current.atFloor).toBe(false);
    act(() => {
      expect(result.current.handleError("stalled")).toBe(false);
      result.current.onHealthSample({
        bytes: 1,
        mediaSeconds: 0,
        wallSeconds: 1,
      });
    });
  });

  it("leaves an offline camera's error to the fallback", () => {
    const { result, rerender, cameraName, streams } = setup();
    const offlineStats: unknown = {
      cameras: { [cameraName]: { camera_fps: 0 } },
      service: { uptime: 120 },
    };
    fixture.stats = offlineStats as FrigateStats;
    rerender({ selected: true, paused: false });
    act(() => {
      expect(result.current.handleError("stalled")).toBe(false);
    });
    expect(result.current.streamName).toBe(streams[0]);
  });

  it("feeds samples and climbs back after clean time", () => {
    const { result, streams } = setup();
    act(() => {
      result.current.handleError("stalled");
    });
    act(() => {
      result.current.onHealthSample({
        bytes: 1000,
        mediaSeconds: 1,
        wallSeconds: 1,
      });
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.streamName).toBe(streams[0]);
  });

  it("does not count hidden time as clean time", () => {
    const { result, streams } = setup();
    act(() => {
      result.current.handleError("stalled");
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(result.current.streamName).toBe(streams[1]);
  });

  it("holds the low stream for data saver", () => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { saveData: true },
    });
    try {
      const { result, streams } = setup();
      expect(result.current.streamName).toBe(streams[1]);
      expect(result.current.reason).toBe("saveData");
    } finally {
      delete (navigator as { connection?: unknown }).connection;
    }
  });

  it("ignores errors while paused", () => {
    const { result, rerender, streams } = setup();
    rerender({ selected: true, paused: true });
    act(() => {
      expect(result.current.handleError("stalled")).toBe(false);
    });
    expect(result.current.streamName).toBe(streams[0]);
  });
});
