import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PROBE_FAILURE_TTL_MS,
  probeWebRTCAvailability,
  resetWebRTCProbe,
} from "./webrtcProbe";

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
  static urls: string[] = [];
  send = vi.fn();
  close = vi.fn();
  constructor(url: string) {
    super();
    Socket.latest = this;
    Socket.urls.push(url);
  }
}

function reply(message: object) {
  Socket.latest.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(message) }),
  );
}

function connect() {
  Peer.latest.iceConnectionState = "connected";
  Peer.latest.oniceconnectionstatechange?.();
}
beforeEach(() => {
  vi.useFakeTimers();
  resetWebRTCProbe();
  Socket.urls = [];
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
    const result = probeWebRTCAvailability(["front"], []);
    expect(probeWebRTCAvailability(["other"], [])).toBe(result);
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
    const result = probeWebRTCAvailability(["front"], []);
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
  const result = probeWebRTCAvailability(["front"], [], 50);
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
  expect(await probeWebRTCAvailability(["front"], [])).toMatchObject({
    ok: false,
    detail: expect.stringContaining("blocked"),
  });
  resetWebRTCProbe();
  vi.stubGlobal("WebSocket", Socket);
  const result = probeWebRTCAvailability(["front"], []);
  Socket.latest.dispatchEvent(new Event("error"));
  expect(await result).toEqual({
    ok: false,
    detail: "WebSocket to go2rtc errored",
  });
});
it.each(["offer", "candidate", "answer"])(
  "reports rejected %s negotiation",
  async (operation) => {
    const result = probeWebRTCAvailability(["front"], []);
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
it("offers audio as well as video so an audio-only stream can answer", () => {
  void probeWebRTCAvailability(["front"], []);
  expect(Peer.latest.addTransceiver).toHaveBeenCalledWith("video", {
    direction: "recvonly",
  });
  expect(Peer.latest.addTransceiver).toHaveBeenCalledWith("audio", {
    direction: "recvonly",
  });
});
it("treats a go2rtc error reply as an unavailable stream and tries the next", async () => {
  const result = probeWebRTCAvailability(["offline", "online"], []);
  const first = Peer.latest;
  reply({ type: "error", value: "streams: dial tcp: i/o timeout" });
  await vi.advanceTimersByTimeAsync(0);
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(Peer.latest).not.toBe(first);
  connect();
  expect(await result).toEqual({ ok: true });
  expect(Socket.urls.map((url) => url.split("src=")[1])).toEqual([
    "offline",
    "online",
  ]);
});
it("reports the stream error without waiting for the timeout", async () => {
  const result = probeWebRTCAvailability(["a", "b", "c", "d"], [], 60_000);
  for (let attempt = 0; attempt < 3; attempt++) {
    reply({ type: "error", value: "source offline" });
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(await result).toEqual({
    ok: false,
    streamError: true,
    detail: "go2rtc stream c unavailable: source offline",
  });
  // Capped so a config full of offline streams cannot stall the verdict.
  expect(Socket.urls).toHaveLength(3);
});
it("reports when there is no stream to probe", async () => {
  expect(await probeWebRTCAvailability([], [])).toEqual({
    ok: false,
    detail: "no go2rtc stream to probe",
  });
});
it("re-probes after a failure expires but keeps a success", async () => {
  const failed = probeWebRTCAvailability(["front"], [], 50);
  await vi.advanceTimersByTimeAsync(50);
  expect(await failed).toMatchObject({ ok: false });
  expect(probeWebRTCAvailability(["front"], [])).toBe(failed);

  await vi.advanceTimersByTimeAsync(PROBE_FAILURE_TTL_MS);
  const retried = probeWebRTCAvailability(["front"], []);
  expect(retried).not.toBe(failed);
  connect();
  expect(await retried).toEqual({ ok: true });

  await vi.advanceTimersByTimeAsync(PROBE_FAILURE_TTL_MS * 2);
  expect(probeWebRTCAvailability(["front"], [])).toBe(retried);
});
it("turns a thrown peer connection into an expiring failure", async () => {
  vi.stubGlobal(
    "RTCPeerConnection",
    class {
      constructor() {
        throw new Error("no peer");
      }
    },
  );
  const failed = probeWebRTCAvailability(["front"], []);
  expect(await failed).toEqual({ ok: false, detail: "no peer" });
  await vi.advanceTimersByTimeAsync(PROBE_FAILURE_TTL_MS);
  expect(probeWebRTCAvailability(["front"], [])).not.toBe(failed);
});
