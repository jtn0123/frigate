import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebRtcPlayer from "./WebRTCPlayer";

class FakeTrack {
  stop = vi.fn();
  constructor(public kind: string) {}
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  senders: { track: FakeTrack | null }[] = [];
  close = vi.fn();
  addEventListener = vi.fn();
  constructor() {
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
  it("stops the microphone when two-way talk is turned off", async () => {
    const mic = new FakeTrack("audio");
    getUserMedia.mockResolvedValue({ getTracks: () => [mic] });
    const { rerender } = render(
      <WebRtcPlayer camera="front_door" microphoneEnabled />,
    );
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);

    rerender(<WebRtcPlayer camera="front_door" microphoneEnabled={false} />);

    expect(FakePeerConnection.instances[0].close).toHaveBeenCalledOnce();
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
