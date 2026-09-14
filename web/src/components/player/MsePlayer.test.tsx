import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MSEPlayer from "./MsePlayer";

vi.mock("@/hooks/use-user-persistence", () => ({
  useUserPersistence: () => [3],
}));
vi.mock("react-device-detect", () => ({ isIOS: false, isSafari: false }));

class FakeSocket extends EventTarget {
  static CLOSED = 3;
  static OPEN = 1;
  readyState = 0;
  binaryType = "";
  close = vi.fn();
}

beforeEach(() => {
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
