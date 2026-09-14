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
