import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { probeWebRTCAvailability, resetWebRTCProbe } from "./webrtcProbe";

class Peer extends EventTarget {
  static latest: Peer;
  iceConnectionState = "new";
  localDescription = { sdp: "local-sdp" };
  oniceconnectionstatechange: (() => void) | null = null;
  addTransceiver = vi.fn();
  createOffer = vi.fn().mockResolvedValue({ sdp: "offer" });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  close = vi.fn();
  constructor() {
    super();
    Peer.latest = this;
  }
}
class Socket extends EventTarget {
  static latest: Socket;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    super();
    Socket.latest = this;
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  resetWebRTCProbe();
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["connected", "completed"])(
  "caches success after ICE becomes %s",
  async (state) => {
    const result = probeWebRTCAvailability("front", []);
    expect(probeWebRTCAvailability("other", [])).toBe(result);
    Socket.latest.dispatchEvent(new Event("open"));
    await vi.advanceTimersByTimeAsync(0);
    expect(Socket.latest.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "webrtc/offer", value: "local-sdp" }),
    );
    Peer.latest.dispatchEvent(new MessageEvent("icecandidate", { data: null }));
    const event = new Event("icecandidate");
    Object.defineProperty(event, "candidate", {
      value: { candidate: "candidate" },
    });
    Peer.latest.dispatchEvent(event);
    expect(Socket.latest.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "webrtc/candidate", value: "candidate" }),
    );
    for (const message of [
      "bad json",
      JSON.stringify({ type: "webrtc/answer", value: "answer" }),
      JSON.stringify({ type: "webrtc/candidate", value: "remote" }),
    ])
      Socket.latest.dispatchEvent(
        new MessageEvent("message", { data: message }),
      );
    expect(Peer.latest.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "answer",
    });
    expect(Peer.latest.addIceCandidate).toHaveBeenCalledWith({
      candidate: "remote",
      sdpMid: "0",
    });
    Peer.latest.iceConnectionState = state;
    Peer.latest.oniceconnectionstatechange?.();
    expect(await result).toEqual({ ok: true });
    Socket.latest.dispatchEvent(new Event("error"));
    expect(Peer.latest.close).toHaveBeenCalledTimes(1);
    expect(Socket.latest.close).toHaveBeenCalledTimes(1);
  },
);
it.each(["failed", "closed"])(
  "reports ICE %s and closes transports",
  async (state) => {
    const result = probeWebRTCAvailability("front", []);
    Peer.latest.iceConnectionState = "checking";
    Peer.latest.oniceconnectionstatechange?.();
    Peer.latest.iceConnectionState = state;
    Peer.latest.oniceconnectionstatechange?.();
    expect(await result).toEqual({
      ok: false,
      detail: `ICE connection state: ${state}`,
    });
  },
);
it("times out and tolerates errors during cleanup", async () => {
  const result = probeWebRTCAvailability("front", [], 50);
  Peer.latest.close.mockImplementation(() => {
    throw new Error("already closed");
  });
  Socket.latest.close.mockImplementation(() => {
    throw new Error("already closed");
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(await result).toEqual({
    ok: false,
    detail: "no ICE connection within 50ms",
  });
});
it("reports websocket creation and connection failures", async () => {
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor() {
        throw new Error("blocked");
      }
    },
  );
  expect(await probeWebRTCAvailability("front", [])).toMatchObject({
    ok: false,
    detail: expect.stringContaining("blocked"),
  });
  resetWebRTCProbe();
  vi.stubGlobal("WebSocket", Socket);
  const result = probeWebRTCAvailability("front", []);
  Socket.latest.dispatchEvent(new Event("error"));
  expect(await result).toEqual({
    ok: false,
    detail: "WebSocket to go2rtc errored",
  });
});
it.each(["offer", "candidate", "answer"])(
  "reports rejected %s negotiation",
  async (operation) => {
    const result = probeWebRTCAvailability("front", []);
    if (operation === "offer") {
      Peer.latest.createOffer.mockRejectedValue("offer failed");
      Socket.latest.dispatchEvent(new Event("open"));
    } else {
      const method =
        operation === "candidate"
          ? Peer.latest.addIceCandidate
          : Peer.latest.setRemoteDescription;
      method.mockRejectedValue(new Error("rejected"));
      Socket.latest.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: `webrtc/${operation}`, value: "value" }),
        }),
      );
    }
    expect(await result).toMatchObject({
      ok: false,
      detail: expect.stringContaining(
        operation === "offer" ? "offer failed" : "rejected",
      ),
    });
  },
);
