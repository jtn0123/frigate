import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import DynamicVideoPlayer from "./DynamicVideoPlayer";

type PlayerProps = ComponentProps<typeof import("../HlsVideoPlayer").default>;
const state = vi.hoisted(() => ({
  player: undefined as PlayerProps | undefined,
  readyState: 2,
  config: { cameras: { front: { detect: {} }, back: { detect: {} } } },
  recordings: [{ start_time: 100, end_time: 200, duration: 100 }],
  preview: {},
}));

vi.mock("@/api", () => ({ useApiHost: () => "/api/" }));
vi.mock("swr", () => ({
  default: (key: unknown) => ({
    data: key === "config" ? state.config : state.recordings,
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
    newPlayback() {}
    seekToTimestamp() {}
    getProgress(time: number) {
      return time;
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
});
afterEach(() => {
  vi.useRealTimers();
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
