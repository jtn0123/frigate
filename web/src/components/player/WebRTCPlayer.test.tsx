import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebRtcPlayer from "./WebRTCPlayer";

const fixture = vi.hoisted(() => ({
  config: {
    go2rtc: { webrtc: { ice_servers: [{ urls: "stun:test.invalid:3478" }] } },
  },
}));
vi.mock("swr", () => ({ default: () => ({ data: fixture.config }) }));

class FakeTrack {
  stop = vi.fn();
  constructor(public kind: string) {}
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  senders: { track: FakeTrack | null }[] = [];
  close = vi.fn();
  addEventListener = vi.fn();
  constructor(public configuration: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }
  addTransceiver(trackOrKind: FakeTrack | string) {
    const kind =
      typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
    this.senders.push({
      track: typeof trackOrKind === "string" ? null : trackOrKind,
    });
    return { receiver: { track: new FakeTrack(kind) } };
  }
  getSenders() {
    return this.senders;
  }
  stats: Record<string, unknown>[] = [];
  getStats() {
    return Promise.resolve(
      new Map(this.stats.map((stat, index) => [String(index), stat])),
    );
  }
}

class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  send = vi.fn();
  close = vi.fn();
  constructor() {
    super();
    FakeSocket.instances.push(this);
  }
}

class FakeMediaStream {
  constructor(public tracks: unknown[]) {}
}

const getUserMedia = vi.fn();

/** Let the peer connection promise and the connect() continuation run. */
async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  FakeSocket.instances = [];
  getUserMedia.mockReset();
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WebRTC two-way talk", () => {
  it("reports microphone permission failure while keeping video connected", async () => {
    getUserMedia.mockRejectedValue(new Error("Permission denied"));
    const onMicrophoneError = vi.fn();
    const { unmount } = render(
      <WebRtcPlayer
        camera="front_door"
        microphoneEnabled
        onMicrophoneError={onMicrophoneError}
      />,
    );
    await settle();
    expect(onMicrophoneError).toHaveBeenCalledWith("microphone");
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakePeerConnection.instances[0].close).not.toHaveBeenCalled();
    unmount();
  });

  it("reports a rejected backchannel and releases its microphone on cleanup", async () => {
    const mic = new FakeTrack("audio");
    getUserMedia.mockResolvedValue({ getTracks: () => [mic] });
    const onMicrophoneError = vi.fn();
    const { unmount } = render(
      <WebRtcPlayer
        camera="front_door"
        microphoneEnabled
        onMicrophoneError={onMicrophoneError}
      />,
    );
    await settle();
    await act(() =>
      FakeSocket.instances[1].dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "error", value: "refused" }),
        }),
      ),
    );
    expect(onMicrophoneError).toHaveBeenCalledWith("refused");
    unmount();
    expect(mic.stop).toHaveBeenCalledOnce();
  });

  it("stops the microphone when two-way talk is turned off", async () => {
    const mic = new FakeTrack("audio");
    getUserMedia.mockResolvedValue({ getTracks: () => [mic] });
    const { rerender } = render(
      <WebRtcPlayer camera="front_door" microphoneEnabled />,
    );
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakePeerConnection.instances[0].configuration.iceServers).toEqual(
      fixture.config.go2rtc.webrtc.ice_servers,
    );

    rerender(<WebRtcPlayer camera="front_door" microphoneEnabled={false} />);

    expect(FakePeerConnection.instances[0].close).not.toHaveBeenCalled();
    expect(FakePeerConnection.instances[1].close).toHaveBeenCalledOnce();
    expect(FakeSocket.instances[0].close).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(mic.stop).toHaveBeenCalledOnce();
  });

  it("stops the microphone when the player unmounts", async () => {
    const mic = new FakeTrack("audio");
    getUserMedia.mockResolvedValue({ getTracks: () => [mic] });
    const { unmount } = render(
      <WebRtcPlayer camera="front_door" microphoneEnabled />,
    );
    await settle();

    unmount();

    expect(FakePeerConnection.instances[0].close).toHaveBeenCalledOnce();
    expect(mic.stop).toHaveBeenCalledOnce();
  });
});

describe("WebRTC connection cancelled during the mic prompt", () => {
  it("closes the connection and opens no socket once playback stopped", async () => {
    const mic = new FakeTrack("audio");
    let grant: (stream: { getTracks: () => FakeTrack[] }) => void = () => {};
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const { rerender } = render(
      <WebRtcPlayer camera="front_door" microphoneEnabled />,
    );
    rerender(
      <WebRtcPlayer
        camera="front_door"
        microphoneEnabled
        playbackEnabled={false}
      />,
    );

    grant({ getTracks: () => [mic] });
    await settle();

    expect(FakeSocket.instances).toHaveLength(0);
    expect(FakePeerConnection.instances[0].close).toHaveBeenCalledOnce();
    expect(mic.stop).toHaveBeenCalledOnce();
  });
});

describe("WebRTC startup timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function advanceSeconds(seconds: number) {
    act(() => {
      vi.advanceTimersByTime(seconds * 1000);
    });
  }

  it("does not report a stall while playback is disabled", () => {
    const onError = vi.fn();
    const { rerender } = render(
      <WebRtcPlayer
        camera="front_door"
        playbackEnabled={false}
        onError={onError}
      />,
    );
    advanceSeconds(6);
    expect(onError).not.toHaveBeenCalled();

    rerender(<WebRtcPlayer camera="front_door" onError={onError} />);
    advanceSeconds(5);
    expect(onError).toHaveBeenCalledExactlyOnceWith("stalled");
  });

  it("stops timing when playback is disabled before the video loads", () => {
    const onError = vi.fn();
    const { rerender } = render(
      <WebRtcPlayer camera="front_door" onError={onError} />,
    );
    advanceSeconds(3);
    rerender(
      <WebRtcPlayer
        camera="front_door"
        playbackEnabled={false}
        onError={onError}
      />,
    );
    advanceSeconds(5);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("WebRTC stats and health samples", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const inbound = (seconds: number, bytes: number, freeze?: number) => ({
    type: "inbound-rtp",
    kind: "video",
    bytesReceived: bytes,
    timestamp: seconds * 1000,
    framesReceived: 100,
    framesDropped: 4,
    framesDecoded: 96,
    totalFreezesDuration: freeze,
  });

  async function setupPlayer(getStats: boolean) {
    const onHealthSample = vi.fn();
    const setStats = vi.fn();
    const element = () => (
      <WebRtcPlayer
        camera="front_door"
        getStats={getStats}
        setStats={setStats}
        onHealthSample={onHealthSample}
      />
    );
    const view = render(element());
    await settle();
    // the stats effect reads the connection created by connect()
    view.rerender(element());
    const video = view.container.querySelector("video")!;
    Object.defineProperty(video, "paused", { get: () => false });
    const pc = FakePeerConnection.instances[0];
    const tick = async (stats: Record<string, unknown>[]) => {
      pc.stats = stats;
      await act(async () => {
        vi.advanceTimersByTime(1000);
        for (let step = 0; step < 5; step += 1) {
          await Promise.resolve();
        }
      });
    };
    return { ...view, video, onHealthSample, setStats, tick };
  }

  it("subtracts freeze time from delivered media", async () => {
    const player = await setupPlayer(false);
    await player.tick([inbound(1, 1000, 0)]);
    // the first report only sets the baseline
    expect(player.onHealthSample).not.toHaveBeenCalled();

    await player.tick([inbound(2, 3000, 0.25)]);
    expect(player.onHealthSample).toHaveBeenLastCalledWith({
      bytes: 2000,
      mediaSeconds: 0.75,
      wallSeconds: 1,
    });
    expect(player.setStats).not.toHaveBeenCalled();
  });

  it("assumes full delivery without the freeze field", async () => {
    const player = await setupPlayer(false);
    await player.tick([inbound(1, 1000)]);
    await player.tick([inbound(3, 2000)]);
    expect(player.onHealthSample).toHaveBeenLastCalledWith({
      bytes: 1000,
      mediaSeconds: 2,
      wallSeconds: 2,
    });
  });

  it("reports bitrate, latency and frames, then clears them", async () => {
    const player = await setupPlayer(true);
    await player.tick([
      inbound(1, 1000),
      {
        type: "candidate-pair",
        state: "succeeded",
        currentRoundTripTime: 0.05,
      },
    ]);
    await player.tick([inbound(2, 5000)]);
    expect(player.setStats).toHaveBeenLastCalledWith({
      streamType: "WebRTC",
      bandwidth: 4,
      latency: 0,
      totalFrames: 100,
      droppedFrames: 4,
      decodedFrames: 96,
      droppedFrameRate: 4,
    });
    player.unmount();
    expect(player.setStats).toHaveBeenLastCalledWith(
      expect.objectContaining({ streamType: "-", bandwidth: 0 }),
    );
  });

  it("reports the stream resolution once video loads", () => {
    const setFullResolution = vi.fn();
    const onPlaying = vi.fn();
    const { container } = render(
      <WebRtcPlayer
        camera="front_door"
        setFullResolution={setFullResolution}
        onPlaying={onPlaying}
      />,
    );
    const video = container.querySelector("video")!;
    Object.defineProperty(video, "videoWidth", { value: 1280 });
    Object.defineProperty(video, "videoHeight", { value: 720 });
    fireEvent.loadedData(video);
    expect(setFullResolution).toHaveBeenCalledWith({
      width: 1280,
      height: 720,
    });
    expect(onPlaying).toHaveBeenCalled();
  });
});
