import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import HlsVideoPlayer from "./HlsVideoPlayer";
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
  supported: true,
  instances: [] as InstanceType<typeof FakeHls>[],
  toast: vi.fn(),
}));
const FakeHls = vi.hoisted(
  () =>
    class {
      static isSupported: () => boolean = () => state.supported;
      static Events: Record<string, string> = {
        ERROR: "error",
        STALL_RESOLVED: "resolved",
        FRAG_LOADED: "loaded",
      };
      static ErrorTypes: Record<string, string> = {
        NETWORK_ERROR: "network",
        MEDIA_ERROR: "media",
      };
      static ErrorDetails: Record<string, string> = {
        BUFFER_INCOMPATIBLE_CODECS_ERROR: "incompatible",
        BUFFER_ADD_CODEC_ERROR: "codec",
        BUFFER_STALLED_ERROR: "stalled",
      };
      handlers = new Map<string, (...args: unknown[]) => void>();
      bandwidthEstimate = 1000;
      levels = [{ bitrate: 500 }];
      startLoad = vi.fn();
      resumeBuffering = vi.fn();
      playingDate = new Date(100000);
      recoverMediaError = vi.fn();
      attachMedia = vi.fn();
      loadSource = vi.fn();
      destroy = vi.fn();
      constructor(public config: Record<string, unknown>) {
        state.instances.push(this);
      }
      on(event: string, callback: (...args: unknown[]) => void) {
        this.handlers.set(event, callback);
      }
      emit(event: string, data: unknown = {}) {
        this.handlers.get(event)?.(event, data);
      }
    },
);
vi.mock("hls.js", () => ({ default: FakeHls }));
vi.mock("swr", () => ({ default: () => ({ data: {} }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: state.toast, success: vi.fn() } }));
vi.mock("react-zoom-pan-pinch", () => ({
  TransformWrapper: ({ children }: { children: ReactNode }) => children,
  TransformComponent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./VideoControls", () => ({ default: () => null }));
vi.mock("@/components/overlay/ObjectTrackOverlay", () => ({
  default: () => null,
}));
vi.mock("@/hooks/use-is-admin", () => ({ useIsAdmin: () => false }));
vi.mock("@/hooks/use-overlay-state", () => ({
  useOverlayState: (_key: string, fallback: unknown) => [fallback, vi.fn()],
}));
vi.mock("@/hooks/use-user-persistence", () => ({
  useUserPersistence: (_key: string, fallback: unknown) => [fallback, vi.fn()],
}));
vi.mock("@/hooks/fork/use-phone-detail-controls", () => ({
  usePhoneDetailControls: () => undefined,
}));
function mount(overrides: Partial<ComponentProps<typeof HlsVideoPlayer>> = {}) {
  const videoRef = { current: null as HTMLVideoElement | null };
  const props = {
    videoRef,
    visible: true,
    currentSource: { playlist: "test.m3u8", startPosition: 4 },
    hotKeys: false,
    supportsFullscreen: false,
    fullscreen: false,
    ...overrides,
  };
  const result = render(<HlsVideoPlayer {...props} />);
  return {
    ...result,
    props,
    video: videoRef.current!,
    hls: state.instances.at(-1)!,
  };
}
beforeEach(() => {
  state.instances = [];
  state.supported = true;
  state.toast.mockReset();
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
  vi.restoreAllMocks();
});
it("seeds throughput and forwards bandwidth and stall events", () => {
  const onBandwidthSample = vi.fn(),
    onStallStart = vi.fn(),
    onStallEnd = vi.fn();
  const { hls, unmount } = mount({
    initialBandwidthEstimate: 3000,
    bufferLength: 25,
    onBandwidthSample,
    onStallStart,
    onStallEnd,
  });
  expect(hls.config).toMatchObject({
    abrEwmaDefaultEstimate: 3000,
    maxBufferLength: 25,
    startPosition: 4,
  });
  act(() => {
    hls.emit("loaded");
    hls.emit("error", { fatal: false, details: "stalled" });
    hls.emit("resolved");
  });
  expect(onBandwidthSample).toHaveBeenCalledWith(1000, 500);
  expect(onStallStart).toHaveBeenCalledOnce();
  expect(onStallEnd).toHaveBeenCalledOnce();
  hls.levels = [];
  act(() => hls.emit("loaded"));
  expect(onBandwidthSample).toHaveBeenLastCalledWith(1000, undefined);
  unmount();
  expect(hls.destroy).toHaveBeenCalledOnce();
});
it("bounds network retries and honors a quality downswitch without recreating HLS", () => {
  const onFatalNetworkError = vi.fn(() => false);
  const { hls, rerender, props } = mount({
    onFatalNetworkError,
    initialBandwidthEstimate: 0,
  });
  expect(hls.config).not.toHaveProperty("abrEwmaDefaultEstimate");
  act(() => {
    for (let i = 0; i < 3; i++)
      hls.emit("error", { fatal: true, type: "network" });
  });
  expect(hls.startLoad).toHaveBeenCalledTimes(2);
  const handled = vi.fn(() => true);
  rerender(<HlsVideoPlayer {...props} onFatalNetworkError={handled} />);
  act(() => hls.emit("error", { fatal: true, type: "network" }));
  expect(handled).toHaveBeenCalledOnce();
  expect(state.instances).toHaveLength(1);
});
it("recovers media errors once and sends codec errors to quality selection", () => {
  const onFatalCodecError = vi.fn(() => true);
  const { hls, video } = mount({ onFatalCodecError });
  Object.defineProperty(video, "error", {
    value: { code: 3, message: "decode" },
    configurable: true,
  });
  fireEvent.error(video);
  expect(state.toast).not.toHaveBeenCalled();
  act(() =>
    hls.emit("error", { fatal: true, type: "media", details: "incompatible" }),
  );
  expect(onFatalCodecError).toHaveBeenCalledOnce();
  expect(hls.recoverMediaError).not.toHaveBeenCalled();
  onFatalCodecError.mockReturnValue(false);
  act(() => {
    for (const details of ["codec", "decode", "decode"])
      hls.emit("error", { fatal: true, type: "media", details });
    hls.emit("error", { fatal: true, type: "other" });
  });
  expect(hls.recoverMediaError).toHaveBeenCalledOnce();
  fireEvent.error(video);
  expect(state.toast).toHaveBeenCalledOnce();
});
it("uses native playback without MSE and retries only once", () => {
  state.supported = false;
  const { video } = mount();
  expect(video.src).toContain("test.m3u8");
  expect(state.instances).toHaveLength(0);
  fireEvent.error(video);
  expect(state.toast).not.toHaveBeenCalled();
  Object.defineProperty(video, "error", {
    value: { code: 1, message: "aborted" },
    configurable: true,
  });
  fireEvent.error(video);
  expect(state.toast).not.toHaveBeenCalled();
  Object.defineProperty(video, "error", {
    value: { code: 2, message: "network" },
    configurable: true,
  });
  fireEvent.error(video);
  expect(state.toast).not.toHaveBeenCalled();
  fireEvent.error(video);
  expect(state.toast).toHaveBeenCalledOnce();
});
it("falls back from native decode errors to HLS compatibility", () => {
  state.supported = false;
  const { video } = mount();
  state.supported = true;
  Object.defineProperty(video, "error", {
    value: { code: 4, message: "unsupported" },
    configurable: true,
  });
  fireEvent.error(video);
  expect(state.instances).toHaveLength(1);
  expect(state.toast).not.toHaveBeenCalled();
});
it("forwards dimensions, seeks and playback and cleans up on source swaps", () => {
  const onPlayerLoaded = vi.fn(),
    setFullResolution = vi.fn(),
    onSeekStart = vi.fn(),
    onPlaying = vi.fn(),
    onTimeUpdate = vi.fn(),
    onClipEnded = vi.fn();
  const { video, hls, props, rerender } = mount({
    onPlayerLoaded,
    setFullResolution,
    onSeekStart,
    onPlaying,
    onTimeUpdate,
    onClipEnded,
  });
  Object.defineProperties(video, {
    videoWidth: { value: 1920 },
    videoHeight: { value: 1080 },
  });
  fireEvent.loadedData(video);
  expect(onPlayerLoaded).toHaveBeenCalledOnce();
  expect(setFullResolution).toHaveBeenCalledWith({ width: 1920, height: 1080 });
  fireEvent.seeking(video);
  expect(onSeekStart).toHaveBeenCalledOnce();
  fireEvent.playing(video);
  expect(onPlaying).toHaveBeenCalledOnce();
  video.currentTime = 5;
  fireEvent.timeUpdate(video);
  fireEvent.ended(video);
  expect(onTimeUpdate).toHaveBeenCalled();
  expect(onClipEnded).toHaveBeenCalled();
  rerender(
    <HlsVideoPlayer {...props} currentSource={{ playlist: "next.m3u8" }} />,
  );
  expect(hls.destroy).toHaveBeenCalledOnce();
  expect(state.instances.at(-1)?.loadSource).toHaveBeenCalledWith("next.m3u8");
});
