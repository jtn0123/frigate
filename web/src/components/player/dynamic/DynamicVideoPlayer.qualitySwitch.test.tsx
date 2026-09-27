import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import type { RecordingCoverage } from "@/types/record";
import DynamicVideoPlayer from "./DynamicVideoPlayer";

// drives the real HlsVideoPlayer so the parent and child effect order on
// a quality switch is exercised end to end
vi.hoisted(() =>
  vi.stubGlobal("MediaError", {
    MEDIA_ERR_ABORTED: 1,
    MEDIA_ERR_NETWORK: 2,
    MEDIA_ERR_DECODE: 3,
    MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
  }),
);
afterAll(() => vi.unstubAllGlobals());

const state = vi.hoisted(() => ({
  instances: [] as InstanceType<typeof FakeHls>[],
  media: { currentTime: 0, readyState: 0 },
  previewClassName: "",
  preview: { src: "preview.mp4" },
  setter: vi.fn(),
  previewController: {},
  config: { cameras: { front: { detect: {} } } },
  coverage: undefined as RecordingCoverage | undefined,
}));

const FakeHls = vi.hoisted(
  () =>
    class {
      static isSupported: () => boolean = () => true;
      static Events: Record<string, string> = {
        ERROR: "error",
        STALL_RESOLVED: "resolved",
        FRAG_LOADED: "loaded",
      };
      static ErrorTypes: Record<string, string> = {
        NETWORK_ERROR: "network",
        MEDIA_ERROR: "media",
      };
      static ErrorDetails: Record<string, string> = {};
      bandwidthEstimate = 1000;
      levels = [];
      destroy = vi.fn();
      loadSource = vi.fn();
      resumeBuffering = vi.fn();
      constructor(public config: Record<string, unknown>) {
        state.instances.push(this);
      }
      on() {}
      // hls.js attaches through media.load(), which resets the element
      attachMedia() {
        state.media.currentTime = 0;
        state.media.readyState = 0;
      }
    },
);

vi.mock("hls.js", () => ({ default: FakeHls }));
vi.mock("swr", () => ({
  default: (key: unknown) => ({
    data: key === "config" ? state.config : state.coverage,
  }),
}));
vi.mock("@/api", () => ({ useApiHost: () => "/api/" }));
vi.mock("@/hooks/use-user-persistence", () => ({
  useUserPersistence: (key: string, fallback: unknown) => [
    key === "playbackBandwidthEstimate" ? 20_000_000 : fallback,
    state.setter,
    true,
  ],
}));
vi.mock("@/hooks/use-overlay-state", () => ({
  useOverlayState: (_key: string, fallback: unknown) => [
    fallback,
    state.setter,
  ],
}));
vi.mock("@/hooks/use-is-admin", () => ({ useIsAdmin: () => false }));
vi.mock("@/hooks/fork/use-phone-detail-controls", () => ({
  usePhoneDetailControls: () => undefined,
}));
vi.mock("@/context/detail-stream-context", () => ({
  useDetailStream: () => ({ isDetailMode: false }),
}));
vi.mock("@/hooks/use-camera-previews", () => ({
  usePreviewForTimeRange: () => state.preview,
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-zoom-pan-pinch", () => ({
  TransformWrapper: ({ children }: { children: ReactNode }) => children,
  TransformComponent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../VideoControls", () => ({ default: () => null }));
vi.mock("@/components/overlay/ObjectTrackOverlay", () => ({
  default: () => null,
}));
vi.mock("./DynamicVideoController", () => ({
  DynamicVideoController: class {
    newPlayback() {}
    seekToTimestamp() {}
    getProgress(time: number) {
      return 100 + time;
    }
  },
}));
vi.mock("../PreviewPlayer", async () => {
  const { useEffect } = await import("react");
  return {
    default: function MockPreviewPlayer({
      className,
      onControllerReady,
    }: {
      className?: string;
      onControllerReady: (value: unknown) => void;
    }) {
      state.previewClassName = className ?? "";
      useEffect(
        () => onControllerReady(state.previewController),
        [onControllerReady],
      );
      return null;
    },
  };
});

const timeline = [{ start_time: 100, end_time: 200, duration: 100000 }];
const props: ComponentProps<typeof DynamicVideoPlayer> = {
  camera: "front",
  timeRange: { after: 100, before: 200 },
  cameraPreviews: [],
  startTimestamp: 100,
  isScrubbing: false,
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
  state.instances = [];
  state.media = { currentTime: 0, readyState: 0 };
  state.coverage = {
    spans: [{ start_time: 100, end_time: 200, streams: ["main", "sub"] }],
    streams: {
      main: {
        video_codec: "h264",
        has_audio: true,
        audio_codec: null,
        audio_rate: null,
        bitrate: 4_000_000,
      },
      sub: {
        video_codec: "h264",
        has_audio: false,
        audio_codec: null,
        audio_rate: null,
        bitrate: 500_000,
      },
    },
    timelines: { auto: timeline, main: timeline, sub: timeline },
    codecs_compatible: true,
  };
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockImplementation(
    () => state.media.currentTime,
  );
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(
    () => state.media.readyState,
  );
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined,
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("rebuilds hls once on the new playlist and keeps the playhead on a quality switch", () => {
  const { rerender } = render(<DynamicVideoPlayer {...props} quality="main" />);
  expect(state.instances).toHaveLength(1);
  const initial = state.instances[0];
  expect(initial.loadSource).toHaveBeenCalledWith(
    expect.stringContaining("/main/"),
  );

  // playing 25 s into the chunk with a decoded frame on screen
  state.media.currentTime = 25;
  state.media.readyState = 4;

  rerender(<DynamicVideoPlayer {...props} quality="sub" />);

  expect(state.instances).toHaveLength(2);
  const rebuilt = state.instances[1];
  expect(initial.destroy).toHaveBeenCalledOnce();
  expect(rebuilt.loadSource).toHaveBeenCalledOnce();
  expect(rebuilt.loadSource).toHaveBeenCalledWith(
    expect.stringContaining("/sub/"),
  );
  // the sub stream keeps its deeper forward buffer
  expect(rebuilt.config).toMatchObject({
    maxBufferLength: 30,
    startPosition: 25,
  });

  // the held frame bridges the load instead of the preview player
  act(() => {
    vi.advanceTimersByTime(1100);
  });
  expect(state.previewClassName).toContain("hidden");
});
