import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MSEPlayer from "./MsePlayer";

vi.mock("@/hooks/use-user-persistence", () => ({
  useUserPersistence: () => [3],
}));
vi.mock("react-device-detect", () => ({ isIOS: false, isSafari: false }));

class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  constructor() {
    super();
    FakeSocket.instances.push(this);
  }
  send = vi.fn();
  static CLOSED = 3;
  static OPEN = 1;
  readyState = 0;
  binaryType = "";
  close = vi.fn();
}

class FakeSourceBuffer extends EventTarget {
  mode = "segments";
  updating = false;
  appendBuffer = vi.fn();
  buffered = { length: 0 };
}
class FakeMediaSource extends EventTarget {
  static instances: FakeMediaSource[] = [];
  static isTypeSupported = () => true;
  buffer = new FakeSourceBuffer();
  constructor() {
    super();
    FakeMediaSource.instances.push(this);
  }
  addSourceBuffer() {
    return this.buffer;
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  FakeMediaSource.instances = [];
  vi.stubGlobal("MediaSource", FakeMediaSource);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:test-video");
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("MSE decoder failures", () => {
  it("reports Chrome decoding failure immediately instead of reconnecting silently", () => {
    const onError = vi.fn();
    const { container } = render(
      <MSEPlayer camera="side_yard" onError={onError} />,
    );
    const video = container.querySelector("video")!;
    Object.defineProperty(video, "error", {
      value: { code: 3, message: "PIPELINE_ERROR_DECODE: -12909" },
    });
    fireEvent.error(video);
    expect(onError).toHaveBeenCalledWith("mse-decode", 3);
  });

  it("ignores a late error event without a MediaError", () => {
    const onError = vi.fn();
    const { container } = render(
      <MSEPlayer camera="side_yard" onError={onError} />,
    );
    fireEvent.error(container.querySelector("video")!);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("MSE fragment failures", () => {
  it.each(["append", "queued-append", "source-buffer", "overflow"] as const)(
    "reports %s failure and closes the socket without consuming late fragments",
    (failure) => {
      const onError = vi.fn();
      const { unmount } = render(
        <MSEPlayer camera="side_yard" onError={onError} />,
      );
      const socket = FakeSocket.instances[0];
      act(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.dispatchEvent(new Event("open"));
      });
      const media = FakeMediaSource.instances[0];
      act(() => {
        socket.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "mse",
              value: 'video/mp4; codecs="avc1.42E01E"',
            }),
          }),
        );
      });
      const sendFragment = (bytes: number) =>
        socket.dispatchEvent(
          new MessageEvent("message", { data: new ArrayBuffer(bytes) }),
        );
      act(() => {
        if (failure === "source-buffer") {
          media.buffer.dispatchEvent(new Event("error"));
        } else if (failure === "overflow") {
          media.buffer.updating = true;
          sendFragment(2 * 1024 * 1024);
          sendFragment(1);
        } else {
          media.buffer.appendBuffer.mockImplementation(() => {
            throw new DOMException("Rejected fragment", "InvalidStateError");
          });
          if (failure === "queued-append") {
            media.buffer.updating = true;
            sendFragment(8);
            media.buffer.updating = false;
            media.buffer.dispatchEvent(new Event("updateend"));
          } else sendFragment(8);
        }
      });
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        failure === "overflow" ? "stalled" : "mse-decode",
        undefined,
      );
      expect(socket.close).toHaveBeenCalledOnce();
      const appends = media.buffer.appendBuffer.mock.calls.length;
      act(() => {
        sendFragment(8);
      });
      expect(media.buffer.appendBuffer).toHaveBeenCalledTimes(appends);
      expect(onError).toHaveBeenCalledOnce();
      unmount();
      expect(socket.close).toHaveBeenCalledOnce();
    },
  );
});

describe("MSE health samples", () => {
  function setupPlayer(props: Partial<Parameters<typeof MSEPlayer>[0]> = {}) {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const onHealthSample = vi.fn();
    const view = render(
      <MSEPlayer
        camera="side_yard"
        onHealthSample={onHealthSample}
        {...props}
      />,
    );
    const video = view.container.querySelector("video")!;
    let bufferedEnd = 0;
    Object.defineProperty(video, "buffered", {
      get: () => ({ length: 1, end: () => bufferedEnd, start: () => 0 }),
    });
    Object.defineProperty(video, "paused", { get: () => false });
    const socket = FakeSocket.instances[0];
    act(() => {
      socket.readyState = FakeSocket.OPEN;
      socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "mse",
            value: 'video/mp4; codecs="avc1.42E01E"',
          }),
        }),
      );
    });
    const media = FakeMediaSource.instances[0];
    return {
      ...view,
      video,
      onHealthSample,
      setBufferedEnd: (end: number) => {
        bufferedEnd = end;
      },
      sendFragment: (bytes: number) =>
        act(() => {
          socket.dispatchEvent(
            new MessageEvent("message", { data: new ArrayBuffer(bytes) }),
          );
        }),
      appended: () =>
        act(() => {
          media.buffer.dispatchEvent(new Event("updateend"));
        }),
      tick: () =>
        act(() => {
          vi.advanceTimersByTime(1000);
        }),
    };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports delivered media against wall time", () => {
    const player = setupPlayer();
    player.sendFragment(500);
    player.appended();
    player.setBufferedEnd(1);
    player.tick();
    expect(player.onHealthSample).toHaveBeenLastCalledWith({
      bytes: 500,
      mediaSeconds: 1,
      wallSeconds: 1,
    });
  });

  it("waits one tick for an append that is still landing", () => {
    const player = setupPlayer();
    player.sendFragment(500);
    player.tick();
    expect(player.onHealthSample).not.toHaveBeenCalled();
    player.setBufferedEnd(2);
    player.tick();
    expect(player.onHealthSample).toHaveBeenCalledExactlyOnceWith({
      bytes: 500,
      mediaSeconds: 2,
      wallSeconds: 2,
    });
  });

  it("skips a new timeline and a hidden page", () => {
    const player = setupPlayer();
    player.setBufferedEnd(5);
    player.tick();
    expect(player.onHealthSample).toHaveBeenCalledOnce();

    player.setBufferedEnd(1);
    player.tick();
    expect(player.onHealthSample).toHaveBeenCalledOnce();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    player.setBufferedEnd(2);
    player.tick();
    expect(player.onHealthSample).toHaveBeenCalledOnce();
  });

  it("reports stats alongside health and clears them on unmount", () => {
    const setStats = vi.fn();
    const player = setupPlayer({ getStats: true, setStats });
    Object.defineProperty(player.video, "getVideoPlaybackQuality", {
      value: () => ({ totalVideoFrames: 100, droppedVideoFrames: 5 }),
    });
    player.sendFragment(2000);
    player.appended();
    player.tick();
    expect(setStats).toHaveBeenLastCalledWith(
      expect.objectContaining({
        streamType: "MSE",
        bandwidth: 2,
        totalFrames: 100,
        droppedFrames: 5,
        decodedFrames: 95,
        droppedFrameRate: 5,
      }),
    );
    player.unmount();
    expect(setStats).toHaveBeenLastCalledWith(
      expect.objectContaining({ streamType: "-", bandwidth: 0 }),
    );
  });
});
