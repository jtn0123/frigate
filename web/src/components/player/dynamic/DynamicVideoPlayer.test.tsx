import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RecordingCoverage } from "@/types/record";
import type { ComponentProps } from "react";
import DynamicVideoPlayer from "./DynamicVideoPlayer";

type PlayerProps = ComponentProps<typeof import("../HlsVideoPlayer").default>;
const state = vi.hoisted(() => ({
  player: undefined as PlayerProps | undefined,
  readyState: 2,
  estimate: 10_000_000 as number | undefined,
  saveEstimate: vi.fn(),
  newPlayback: vi.fn(),
  getProgress: vi.fn((time: number) => time),
  codecSupported: true,
  config: { cameras: { front: { detect: {} }, back: { detect: {} } } },
  coverage: {
    spans: [{ start_time: 100, end_time: 200, streams: ["main"] }],
    streams: {
      main: {
        video_codec: "h264",
        has_audio: true,
        audio_codec: null,
        audio_rate: null,
        bitrate: 4_000_000,
      },
    },
    timelines: {
      auto: [{ start_time: 100, end_time: 200, duration: 100000 }],
      main: [{ start_time: 100, end_time: 200, duration: 100000 }],
      sub: [],
    },
    codecs_compatible: true,
  } as RecordingCoverage,
  preview: {},
}));

vi.mock("@/hooks/use-user-persistence", () => ({
  useUserPersistence: () => [state.estimate, state.saveEstimate, true],
}));
vi.mock("@/utils/codecSupport", () => ({
  isCodecFamilySupported: (codec: string) =>
    codec !== "hevc" || state.codecSupported,
}));
vi.mock("@/api", () => ({ useApiHost: () => "/api/" }));
vi.mock("swr", () => ({
  default: (key: unknown) => ({
    data: key === "config" ? state.config : state.coverage,
  }),
}));
vi.mock("@/context/detail-stream-context", () => ({
  useDetailStream: () => ({ isDetailMode: false }),
}));
vi.mock("@/hooks/use-camera-previews", () => ({
  usePreviewForTimeRange: () => undefined,
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/indicators/activity-indicator", () => ({
  default: () => <div data-testid="loading" />,
}));
vi.mock("./DynamicVideoController", () => ({
  DynamicVideoController: class {
    newPlayback(...args: unknown[]) {
      state.newPlayback(...args);
    }
    seekToTimestamp() {}
    getProgress(time: number) {
      return state.getProgress(time);
    }
  },
}));
vi.mock("../PreviewPlayer", async () => {
  const { useEffect } = await import("react");
  return {
    default: function MockPreviewPlayer({
      onControllerReady,
    }: {
      onControllerReady: (value: unknown) => void;
    }) {
      useEffect(() => onControllerReady(state.preview), [onControllerReady]);
      return null;
    },
  };
});
vi.mock("../HlsVideoPlayer", () => ({
  default: (props: PlayerProps) => {
    state.player = props;
    return (
      <video
        muted
        ref={(node) => {
          props.videoRef.current = node;
          if (node)
            Object.defineProperty(node, "readyState", {
              configurable: true,
              get: () => state.readyState,
            });
        }}
      />
    );
  },
}));

const props: ComponentProps<typeof DynamicVideoPlayer> = {
  camera: "front",
  timeRange: { after: 100, before: 200 },
  cameraPreviews: [],
  startTimestamp: 100,
  isScrubbing: true,
  hotKeys: false,
  supportsFullscreen: false,
  fullscreen: false,
  onControllerReady: () => {},
  onTimestampUpdate: () => {},
  setFullResolution: () => {},
  toggleFullscreen: () => {},
};

beforeEach(() => {
  vi.useFakeTimers();
  state.readyState = 2;
  state.player = undefined;
  state.estimate = 10_000_000;
  state.saveEstimate.mockReset();
  state.newPlayback.mockClear();
  state.getProgress.mockClear();
  state.codecSupported = true;
  state.coverage = {
    spans: [{ start_time: 100, end_time: 200, streams: ["main"] }],
    streams: {
      main: {
        video_codec: "h264",
        audio_codec: null,
        audio_rate: null,
        has_audio: true,
        bitrate: 4_000_000,
      },
    },
    timelines: {
      auto: [{ start_time: 100, end_time: 200, duration: 100000 }],
      main: [{ start_time: 100, end_time: 200, duration: 100000 }],
      sub: [],
    },
    codecs_compatible: true,
  };
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "connection");
});

it("clears a paused loading state when a settled timeline selection is cancelled", () => {
  const { rerender } = render(<DynamicVideoPlayer {...props} />);
  act(() => {
    state.player?.onPlayerLoaded?.();
    vi.advanceTimersByTime(1100);
  });
  rerender(<DynamicVideoPlayer {...props} isScrubbing={false} />);
  expect(screen.queryByTestId("loading")).not.toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(1100);
  });
  expect(screen.queryByTestId("loading")).not.toBeInTheDocument();
});

it("still shows loading when the selected media has not settled", () => {
  state.readyState = 0;
  const { rerender } = render(<DynamicVideoPlayer {...props} />);
  rerender(<DynamicVideoPlayer {...props} isScrubbing={false} />);
  act(() => {
    vi.advanceTimersByTime(1100);
  });
  expect(screen.getByTestId("loading")).toBeInTheDocument();
});

it("does not reuse the previous camera's settled state", () => {
  const { rerender } = render(<DynamicVideoPlayer {...props} />);
  act(() => {
    state.player?.onPlayerLoaded?.();
  });
  rerender(<DynamicVideoPlayer {...props} camera="back" isScrubbing={false} />);
  act(() => {
    vi.advanceTimersByTime(1100);
  });
  expect(screen.getByTestId("loading")).toBeInTheDocument();
});

it("does not let an abandoned timer restore loading after playback starts", () => {
  const { rerender, unmount } = render(
    <DynamicVideoPlayer {...props} isScrubbing={false} />,
  );
  rerender(<DynamicVideoPlayer {...props} />);
  rerender(<DynamicVideoPlayer {...props} isScrubbing={false} />);
  act(() => {
    state.player?.onPlaying?.();
    state.player?.onTimeUpdate?.(101);
    vi.advanceTimersByTime(1100);
  });
  expect(screen.queryByTestId("loading")).not.toBeInTheDocument();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

function enableSub() {
  state.coverage.spans[0].streams = ["main", "sub"];
  state.coverage.streams.sub = {
    video_codec: "h264",
    audio_codec: null,
    audio_rate: null,
    has_audio: false,
    bitrate: 500000,
  };
  state.coverage.timelines!.sub = [...state.coverage.timelines!.main!];
}
it("downswitches after a fatal network error then restores main with measured headroom", () => {
  enableSub();
  const onAutoQualityChange = vi.fn();
  const { unmount } = render(
    <DynamicVideoPlayer
      {...props}
      isScrubbing={false}
      onAutoQualityChange={onAutoQualityChange}
    />,
  );
  act(() => {
    expect(state.player?.onFatalNetworkError?.()).toBe(true);
  });
  expect(state.player?.currentSource.playlist).toContain("/sub/");
  expect(state.player?.bufferLength).toBe(30);
  act(() => {
    state.player?.onBandwidthSample?.(20_000_000);
    state.player?.onBandwidthSample?.(20_000_000);
  });
  expect(state.player?.currentSource.playlist).not.toContain("/sub/");
  expect(onAutoQualityChange).toHaveBeenLastCalledWith(false, undefined);
  unmount();
  expect(state.saveEstimate).toHaveBeenCalledWith(20_000_000);
});
it.each(["main", "sub"] as const)(
  "never overrides a manually pinned %s stream",
  (quality) => {
    enableSub();
    render(<DynamicVideoPlayer {...props} quality={quality} />);
    act(() => {
      expect(state.player?.onFatalNetworkError?.()).toBe(false);
      state.player?.onFatalCodecError?.();
    });
    expect(state.player?.currentSource.playlist).toContain(`/${quality}/`);
  },
);
it.each(["cold", "slow", "codec", "saveData"])(
  "starts low for %s and reports the reason",
  (reason) => {
    enableSub();
    if (reason === "cold") state.estimate = undefined;
    if (reason === "slow") state.estimate = 1_000_000;
    if (reason === "codec") {
      state.codecSupported = false;
      state.coverage.streams.main!.video_codec = "hevc";
    }
    if (reason === "saveData")
      Object.defineProperty(navigator, "connection", {
        configurable: true,
        value: { saveData: true },
      });
    const onAutoQualityChange = vi.fn();
    render(
      <DynamicVideoPlayer
        {...props}
        onAutoQualityChange={onAutoQualityChange}
      />,
    );
    expect(state.player?.currentSource.playlist).toContain("/sub/");
    expect(onAutoQualityChange).toHaveBeenLastCalledWith(
      true,
      reason === "codec" || reason === "saveData" ? reason : "bandwidth",
    );
  },
);
it("handles repeated downswitch signals and re-anchors a manual quality change", () => {
  enableSub();
  const onSeekToTime = vi.fn();
  const onTimestampUpdate = vi.fn();
  const { rerender } = render(
    <DynamicVideoPlayer
      {...props}
      isScrubbing={false}
      onSeekToTime={onSeekToTime}
      onTimestampUpdate={onTimestampUpdate}
    />,
  );
  state.coverage = structuredClone(state.coverage);
  rerender(
    <DynamicVideoPlayer
      {...props}
      isScrubbing={false}
      onSeekToTime={onSeekToTime}
      onTimestampUpdate={onTimestampUpdate}
    />,
  );
  act(() => {
    vi.advanceTimersByTime(1100);
  });
  act(() => {
    state.player?.onPlaying?.();
  });
  act(() => {
    state.player?.onPlaying?.();
    state.player?.onTimeUpdate?.(125);
    state.player?.onSeekToTime?.(130, true);
    state.player?.onSeekStart?.();
    state.player?.onStallStart?.();
    state.player?.onStallEnd?.();
  });
  expect(state.newPlayback).toHaveBeenCalled();
  expect(state.getProgress).toHaveBeenCalledWith(125);
  expect(onTimestampUpdate).toHaveBeenCalledWith(125);
  expect(onSeekToTime).toHaveBeenCalledWith(130, true);
  act(() => {
    expect(state.player?.onFatalCodecError?.()).toBe(true);
  });
  act(() => {
    expect(state.player?.onFatalNetworkError?.()).toBe(false);
  });
  rerender(
    <DynamicVideoPlayer
      {...props}
      quality="main"
      startTimestamp={150}
      isScrubbing={false}
    />,
  );
  expect(state.player?.currentSource.playlist).toContain("/main/");
  expect(state.player?.currentSource.playlist).toContain("150");
});
