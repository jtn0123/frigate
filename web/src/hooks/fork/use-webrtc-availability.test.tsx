import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isWebRTCConfigured,
  useWebRTCAvailableForStream,
  useWebRTCGloballyAvailable,
  webRTCProbeStreams,
  webRTCTalkState,
} from "../use-webrtc-availability";
import type { FrigateConfig } from "@/types/frigateConfig";

type Go2rtc = FrigateConfig["go2rtc"];

const DEFAULT_GO2RTC: Go2rtc = {
  streams: { front: [] },
  webrtc: { candidates: ["localhost:8555"] },
};

const fixture = vi.hoisted(() => ({
  probe: vi.fn<(streams: string[]) => Promise<{ ok: boolean }>>(),
  config: { go2rtc: {} as FrigateConfig["go2rtc"] },
}));
vi.mock("swr", () => ({ default: () => ({ data: fixture.config }) }));
vi.mock("@/utils/webrtcProbe", () => ({
  probeWebRTCAvailability: fixture.probe,
  resetWebRTCProbe: vi.fn(),
}));
beforeEach(() => {
  vi.stubGlobal("RTCPeerConnection", class {});
  fixture.probe.mockReset();
  fixture.config = { go2rtc: DEFAULT_GO2RTC };
});
afterEach(() => vi.unstubAllGlobals());
it("resolves a rejected connectivity probe instead of leaving the selector checking", async () => {
  fixture.probe.mockRejectedValue(new Error("Peer connection unavailable"));
  const { result } = renderHook(() => useWebRTCGloballyAvailable());
  await waitFor(() =>
    expect(result.current).toEqual({
      globallyAvailable: false,
      globalReason: "unreachable",
    }),
  );
});

describe("go2rtc WebRTC configuration", () => {
  it.each([
    ["no webrtc section (stock config)", undefined, true],
    ["webrtc without candidates", {}, true],
    ["user candidates", { candidates: ["10.0.0.2:8555"] }, true],
    [
      "empty candidates with ice servers",
      { candidates: [], ice_servers: [{ urls: "stun:stun.example" }] },
      true,
    ],
    ["explicitly empty candidates", { candidates: [] }, false],
    [
      "empty candidates and ice servers",
      { candidates: [], ice_servers: [] },
      false,
    ],
  ] as const)("%s", (_label, webrtc, expected) => {
    expect(isWebRTCConfigured(webrtc as Go2rtc["webrtc"])).toBe(expected);
  });

  it("probes a stock config instead of reporting not-configured", async () => {
    fixture.config = { go2rtc: { streams: { front: [] } } };
    fixture.probe.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useWebRTCGloballyAvailable());
    await waitFor(() =>
      expect(result.current).toEqual({
        globallyAvailable: true,
        globalReason: null,
      }),
    );
  });

  it("does not probe when candidates were explicitly emptied", () => {
    fixture.config = {
      go2rtc: { streams: { front: [] }, webrtc: { candidates: [] } },
    };
    const { result } = renderHook(() => useWebRTCGloballyAvailable());
    expect(result.current.globalReason).toBe("not-configured");
    expect(fixture.probe).not.toHaveBeenCalled();
  });
});

describe("probe stream selection", () => {
  it("puts the viewed stream first and ignores unknown names", () => {
    const streams = { a: [], b: [], c: [] };
    expect(webRTCProbeStreams(streams, "b")).toEqual(["b", "a", "c"]);
    expect(webRTCProbeStreams(streams, "zzz")).toEqual(["a", "b", "c"]);
    expect(webRTCProbeStreams(streams)).toEqual(["a", "b", "c"]);
    expect(webRTCProbeStreams(undefined, "a")).toEqual([]);
  });

  it("probes the stream being viewed rather than the first configured one", async () => {
    fixture.config = {
      go2rtc: { ...DEFAULT_GO2RTC, streams: { front: [], back: [] } },
    };
    fixture.probe.mockResolvedValue({ ok: true });
    const { result } = renderHook(() =>
      useWebRTCAvailableForStream(undefined, "back"),
    );
    await waitFor(() => expect(result.current).toEqual({ available: true }));
    expect(fixture.probe).toHaveBeenCalledWith(
      ["back", "front"],
      [{ urls: "stun:stun.l.google.com:19302" }],
    );
  });

  it("skips the probe when go2rtc has no streams", () => {
    fixture.config = { go2rtc: { ...DEFAULT_GO2RTC, streams: {} } };
    const { result } = renderHook(() => useWebRTCGloballyAvailable());
    expect(result.current.globalReason).toBe("checking");
    expect(fixture.probe).not.toHaveBeenCalled();
  });
});

describe("probe retry", () => {
  function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => setVisibility("visible"));

  it("re-probes a failure when the page becomes visible again", async () => {
    fixture.probe.mockResolvedValueOnce({ ok: false });
    const { result } = renderHook(() => useWebRTCGloballyAvailable());
    await waitFor(() =>
      expect(result.current.globalReason).toBe("unreachable"),
    );
    expect(fixture.probe).toHaveBeenCalledTimes(1);

    fixture.probe.mockResolvedValueOnce({ ok: true });
    act(() => setVisibility("hidden"));
    expect(fixture.probe).toHaveBeenCalledTimes(1);
    act(() => setVisibility("visible"));
    await waitFor(() =>
      expect(result.current).toEqual({
        globallyAvailable: true,
        globalReason: null,
      }),
    );
    expect(fixture.probe).toHaveBeenCalledTimes(2);

    // A pass is final: returning to the page does not probe again.
    act(() => setVisibility("visible"));
    expect(fixture.probe).toHaveBeenCalledTimes(2);
  });
});

describe("two-way talk availability", () => {
  it.each([
    [{ available: true }, "available"],
    // Talk-back does not use the playback audio track (AAC-only cameras).
    [{ available: false, reason: "audio-codec" }, "available"],
    [{ available: false, reason: "checking" }, "pending"],
    [{ available: false, reason: "video-codec" }, "unavailable"],
    [{ available: false, reason: "unreachable" }, "unavailable"],
    [{ available: false, reason: "not-configured" }, "unavailable"],
  ] as const)("%o is %s", (stream, expected) => {
    expect(webRTCTalkState(stream)).toBe(expected);
  });
});
