import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWebRTCGloballyAvailable } from "../use-webrtc-availability";

const fixture = vi.hoisted(() => ({
  probe: vi.fn<() => Promise<{ ok: boolean }>>(),
  config: {
    go2rtc: {
      streams: { front: [] },
      webrtc: { candidates: ["localhost:8555"] },
    },
  },
}));
vi.mock("swr", () => ({ default: () => ({ data: fixture.config }) }));
vi.mock("@/utils/webrtcProbe", () => ({
  probeWebRTCAvailability: fixture.probe,
  resetWebRTCProbe: vi.fn(),
}));
beforeEach(() => {
  vi.stubGlobal("RTCPeerConnection", class {});
  fixture.probe.mockReset();
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
