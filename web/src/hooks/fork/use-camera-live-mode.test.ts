import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraConfig } from "@/types/frigateConfig";
import type { LivePlayerMode } from "@/types/live";
import useCameraLiveMode from "@/hooks/use-camera-live-mode";

const fx = vi.hoisted(() => ({
  config: undefined as unknown,
  metadata: {} as Record<string, unknown>,
  requestedStreams: [] as string[][],
  globallyAvailable: true,
  reason: null as string | null,
}));

vi.mock("swr", () => ({ default: () => ({ data: fx.config }) }));
vi.mock("@/hooks/use-deferred-stream-metadata", () => ({
  default: (names: string[]) => {
    fx.requestedStreams.push(names);
    return fx.metadata;
  },
}));
vi.mock("@/hooks/use-webrtc-availability", () => ({
  useWebRTCGloballyAvailable: () => ({
    globallyAvailable: fx.globallyAvailable,
    globalReason: null,
  }),
  evaluateStreamWebRTCAvailability: () => ({
    available: fx.reason === null,
    reason: fx.reason,
  }),
}));

const asCamera = (value: unknown) => value as CameraConfig;

function camera(name: string, streams: Record<string, string>) {
  return asCamera({ name, live: { streams } });
}

const front = camera("front", { Main: "front_main", Sub: "front_sub" });
const back = camera("back", { Main: "back_rtsp" });

const withAudio = {
  producers: [{ medias: ["video, recvonly, H264", "audio, recvonly, OPUS"] }],
};

function setMse(supported: boolean) {
  Reflect.deleteProperty(window, "MediaSource");
  Reflect.deleteProperty(window, "ManagedMediaSource");
  if (supported) {
    vi.stubGlobal("MediaSource", class {});
  }
}

function run(
  cameras: CameraConfig[],
  options: {
    activeStreams?: Record<string, string>;
    preferredModes?: Record<string, LivePlayerMode | undefined>;
  } = {},
) {
  return renderHook(() =>
    useCameraLiveMode(
      cameras,
      true,
      options.activeStreams,
      options.preferredModes,
    ),
  );
}

beforeEach(() => {
  fx.config = {
    go2rtc: { streams: { front_main: [], front_sub: [] } },
  };
  fx.metadata = { front_main: withAudio };
  fx.requestedStreams = [];
  fx.globallyAvailable = true;
  fx.reason = null;
  setMse(true);
});
afterEach(() => vi.unstubAllGlobals());

describe("useCameraLiveMode", () => {
  it("uses MSE for restreamed cameras and jsmpeg otherwise", () => {
    const { result } = run([front, back]);
    expect(result.current.preferredLiveModes).toEqual({
      front: "mse",
      back: "jsmpeg",
    });
    expect(result.current.isRestreamedStates).toEqual({
      front: true,
      back: false,
    });
    expect(result.current.supportsAudioOutputStates).toEqual({
      front_main: { supportsAudio: true, cameraName: "front" },
      front_sub: { supportsAudio: false, cameraName: "front" },
      back: { supportsAudio: false, cameraName: "back" },
    });
    expect(fx.requestedStreams.at(-1)).toEqual(["front_main", "front_sub"]);
    expect(result.current.streamMetadata).toBe(fx.metadata);
  });

  it("falls back to WebRTC without MSE and to jsmpeg without either", () => {
    setMse(false);
    expect(run([front]).result.current.preferredLiveModes["front"]).toBe(
      "webrtc",
    );

    fx.reason = "video-codec";
    const { result } = run([front]);
    expect(result.current.webRTCUsableStates).toEqual({ front: false });
    expect(result.current.preferredLiveModes["front"]).toBe("jsmpeg");
  });

  it("counts a pending WebRTC check as usable", () => {
    fx.reason = "checking";
    expect(run([front]).result.current.webRTCUsableStates).toEqual({
      front: true,
    });
  });

  it("honors viable per-camera preferences only", () => {
    expect(
      run([front, back], {
        preferredModes: { front: "webrtc", back: "webrtc" },
      }).result.current.preferredLiveModes,
    ).toEqual({ front: "webrtc", back: "jsmpeg" });

    expect(
      run([front], { preferredModes: { front: "jsmpeg" } }).result.current
        .preferredLiveModes["front"],
    ).toBe("jsmpeg");

    setMse(false);
    fx.reason = "unreachable";
    expect(
      run([front], { preferredModes: { front: "mse" } }).result.current
        .preferredLiveModes["front"],
    ).toBe("jsmpeg");
  });

  it("follows the active stream selection", () => {
    fx.config = {
      go2rtc: { streams: { front_sub: [] } },
    };
    const restreamed = run([front], { activeStreams: { front: "front_sub" } });
    expect(fx.requestedStreams.at(-1)).toEqual(["front_sub"]);
    expect(restreamed.result.current.preferredLiveModes["front"]).toBe("mse");

    const direct = run([front], { activeStreams: { front: "front_main" } });
    expect(fx.requestedStreams.at(-1)).toEqual([]);
    expect(direct.result.current.isRestreamedStates["front"]).toBe(false);
    expect(direct.result.current.preferredLiveModes["front"]).toBe("jsmpeg");
  });

  it("treats a config without go2rtc streams as not restreamed", () => {
    fx.config = { go2rtc: {} };
    const { result } = run([front]);
    expect(result.current.isRestreamedStates["front"]).toBe(false);
    expect(fx.requestedStreams.at(-1)).toEqual([]);
  });

  it("reports nothing before the config loads or without cameras", () => {
    fx.config = undefined;
    const loading = run([front]);
    expect(fx.requestedStreams.at(-1)).toEqual([]);
    expect(loading.result.current.isRestreamedStates).toEqual({
      front: false,
    });

    const empty = run([]);
    expect(empty.result.current.preferredLiveModes).toEqual({});
  });

  it("resets a camera to its resolved mode", () => {
    const { result } = run([front, back], {
      preferredModes: { front: "webrtc" },
    });

    act(() =>
      result.current.setPreferredLiveModes((modes) => ({
        ...modes,
        front: "jsmpeg",
        back: "webrtc",
      })),
    );
    expect(result.current.preferredLiveModes["front"]).toBe("jsmpeg");

    act(() => result.current.resetPreferredLiveMode("front"));
    act(() => result.current.resetPreferredLiveMode("back"));
    expect(result.current.preferredLiveModes).toEqual({
      front: "webrtc",
      back: "jsmpeg",
    });

    // an unknown camera resolves its name as the stream
    act(() => result.current.resetPreferredLiveMode("front_main"));
    expect(result.current.preferredLiveModes["front_main"]).toBe("mse");
  });
});
