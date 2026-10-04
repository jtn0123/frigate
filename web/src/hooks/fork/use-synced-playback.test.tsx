import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncedPlaybackEngine } from "@/lib/fork/synced-playback-engine";
import { SYNC_TICK_MS } from "@/lib/fork/synced-playback";
import {
  type SyncedPlaybackOptions,
  useSyncedPlayback,
  useSyncedPlaybackRate,
} from "./use-synced-playback";
import {
  SYNCED_PLAYBACK_MODE_KEY,
  useSyncedPlaybackMode,
} from "./use-synced-playback-mode";

// the user's default speed from the UI settings
const persisted = vi.hoisted(() => ({ rate: undefined as number | undefined }));

vi.mock("@/hooks/use-user-persistence", () => ({
  useUserPersistence: (_key: string, fallback: unknown) => [
    persisted.rate ?? fallback,
    vi.fn(),
  ],
}));

const options = (
  patch: Partial<SyncedPlaybackOptions> = {},
): SyncedPlaybackOptions => ({
  cameras: ["front", "back"],
  mainCamera: "front",
  timeRange: { after: 3600, before: 7200 },
  latestTime: 10800,
  isScrubbing: false,
  rate: 1,
  muted: true,
  startTimestamp: 4000,
  onTimestampUpdate: vi.fn(),
  onSeekToTime: vi.fn(),
  onClipEnded: vi.fn(),
  ...patch,
});

afterEach(() => {
  persisted.rate = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

describe("useSyncedPlayback", () => {
  it("owns one engine that starts at the view's playback start", () => {
    const { result, rerender } = renderHook(
      (props) => useSyncedPlayback(props),
      {
        initialProps: options(),
      },
    );
    const engine = result.current.engine;

    expect(engine).toBeInstanceOf(SyncedPlaybackEngine);
    expect(result.current.snapshot).toMatchObject({
      anchor: 4000,
      playing: true,
    });

    rerender(options({ cameras: ["front"] }));
    expect(result.current.engine).toBe(engine);
    expect(engine.options.cameras).toEqual(["front"]);
  });

  it("ticks while mounted and stops when unmounted", () => {
    vi.useFakeTimers();
    const tick = vi.spyOn(SyncedPlaybackEngine.prototype, "tick");
    const { unmount } = renderHook(() => useSyncedPlayback(options()));

    vi.advanceTimersByTime(SYNC_TICK_MS * 3);
    const calls = tick.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(3);

    unmount();
    vi.advanceTimersByTime(SYNC_TICK_MS * 3);
    expect(tick.mock.calls.length).toBe(calls);
  });

  it("tells the engine about a new chunk with the view's start", () => {
    const chunkChanged = vi.spyOn(
      SyncedPlaybackEngine.prototype,
      "chunkChanged",
    );
    const { rerender } = renderHook((props) => useSyncedPlayback(props), {
      initialProps: options(),
    });
    expect(chunkChanged).not.toHaveBeenCalled();

    rerender(options({ startTimestamp: 4500 }));
    expect(chunkChanged).not.toHaveBeenCalled();

    rerender(
      options({
        timeRange: { after: 7200, before: 10800 },
        startTimestamp: 8000,
      }),
    );
    expect(chunkChanged).toHaveBeenCalledWith(8000);
  });

  it("passes speed and audio changes on at once", () => {
    const setRate = vi.spyOn(SyncedPlaybackEngine.prototype, "setRate");
    const applyMutes = vi.spyOn(SyncedPlaybackEngine.prototype, "applyMutes");
    const { result, rerender } = renderHook(
      (props) => useSyncedPlayback(props),
      {
        initialProps: options(),
      },
    );

    rerender(options({ rate: 4 }));
    expect(setRate).toHaveBeenLastCalledWith(4);

    applyMutes.mockClear();
    rerender(options({ rate: 4, muted: false, mainCamera: "back" }));
    expect(applyMutes).toHaveBeenCalled();
    expect(result.current.engine.options).toMatchObject({
      muted: false,
      mainCamera: "back",
    });
  });

  it("re-renders when the engine publishes", () => {
    const { result } = renderHook(() => useSyncedPlayback(options()));

    act(() => result.current.engine.seekToTimestamp(5000));
    expect(result.current.snapshot.anchor).toBe(5000);
  });
});

describe("useSyncedPlaybackRate", () => {
  /** The view as the single player left it, with its speed choice. */
  const withRate =
    (playbackRate?: number) =>
    ({ children }: { children: ReactNode }) => (
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/review",
            state: playbackRate === undefined ? null : { playbackRate },
          },
        ]}
      >
        {children}
      </MemoryRouter>
    );

  it("plays the single player's 16x at the grid's 8x", () => {
    const { result } = renderHook(() => useSyncedPlaybackRate(), {
      wrapper: withRate(16),
    });

    expect(result.current[0]).toBe(8);
  });

  it("keeps a speed the grid offers and clamps the user's default", () => {
    const { result } = renderHook(() => useSyncedPlaybackRate(), {
      wrapper: withRate(2),
    });
    expect(result.current[0]).toBe(2);

    persisted.rate = 16;
    const { result: fallback } = renderHook(() => useSyncedPlaybackRate(), {
      wrapper: withRate(),
    });
    expect(fallback.current[0]).toBe(8);
  });

  it("plays the speed picked in the grid", () => {
    const { result } = renderHook(() => useSyncedPlaybackRate(), {
      wrapper: withRate(16),
    });

    act(() => result.current[1](4));
    expect(result.current[0]).toBe(4);
  });
});

describe("useSyncedPlaybackMode", () => {
  it("starts off and remembers the choice", () => {
    const { result } = renderHook(() => useSyncedPlaybackMode());
    expect(result.current[0]).toBe(false);

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem(SYNCED_PLAYBACK_MODE_KEY)).toBe("true");

    const { result: next } = renderHook(() => useSyncedPlaybackMode());
    expect(next.current[0]).toBe(true);
  });

  it("stays off when the fork flag is off", async () => {
    localStorage.setItem(SYNCED_PLAYBACK_MODE_KEY, "true");
    vi.resetModules();
    vi.doMock("@/fork/flags", () => ({
      forkFlags: { syncedPlayback: false },
    }));
    const { useSyncedPlaybackMode: useMode } =
      await import("./use-synced-playback-mode");

    const { result } = renderHook(() => useMode());
    expect(result.current[0]).toBe(false);
    vi.doUnmock("@/fork/flags");
  });
});
