import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsFeedMessage } from "@/api/ws";
import { useWsMessageBuffer } from "@/hooks/use-ws-message-buffer";

const ws = vi.hoisted(() => ({
  callback: undefined as ((msg: WsFeedMessage) => void) | undefined,
}));

vi.mock("@/api/ws", () => ({
  useWsMessageSubscribe: (callback: (msg: WsFeedMessage) => void) => {
    ws.callback = callback;
  },
}));

let seq = 0;
function message(topic: string, payload: unknown = "ON"): WsFeedMessage {
  seq += 1;
  return { topic, payload, timestamp: seq, id: String(seq) };
}

function send(...messages: WsFeedMessage[]) {
  act(() => {
    messages.forEach((msg) => ws.callback?.(msg));
  });
}

function flush() {
  act(() => {
    vi.advanceTimersByTime(200);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  ws.callback = undefined;
});
afterEach(() => vi.useRealTimers());

describe("useWsMessageBuffer", () => {
  it("batches messages into the next 200ms tick", () => {
    const { result } = renderHook(() => useWsMessageBuffer());
    const first = message("front/motion");
    send(first);
    expect(result.current.messages).toEqual([]);
    flush();
    expect(result.current.messages).toEqual([first]);

    // an idle tick keeps the same array
    const before = result.current.messages;
    flush();
    expect(result.current.messages).toBe(before);
  });

  it("keeps only the newest messages up to the max size", () => {
    const { result } = renderHook(() => useWsMessageBuffer(2));
    const [a, b, c] = [
      message("front/motion"),
      message("back/motion"),
      message("side/motion"),
    ];
    send(a, b, c);
    flush();
    expect(result.current.messages).toEqual([b, c]);
  });

  it("drops messages while paused", () => {
    const { result, rerender } = renderHook(
      ({ paused }) => useWsMessageBuffer(10, paused),
      { initialProps: { paused: true } },
    );
    send(message("front/motion"));
    flush();
    expect(result.current.messages).toEqual([]);

    rerender({ paused: false });
    const kept = message("front/motion");
    send(kept);
    flush();
    expect(result.current.messages).toEqual([kept]);
  });

  it("filters by a single camera and passes everything for all", () => {
    const { result, rerender } = renderHook(
      ({ camera }) => useWsMessageBuffer(10, false, { cameraFilter: camera }),
      { initialProps: { camera: "front" } },
    );
    const front = message("front/motion");
    send(front, message("back/motion"), message("stats", { cpu: 1 }));
    flush();
    expect(result.current.messages).toEqual([front]);

    rerender({ camera: "all" });
    const back = message("back/motion");
    send(back);
    flush();
    expect(result.current.messages).toEqual([front, back]);
  });

  it("filters by a camera list and keeps messages without a camera", () => {
    const { result } = renderHook(() =>
      useWsMessageBuffer(10, false, { cameraFilter: ["front", "side"] }),
    );
    const front = message("front/motion");
    const event = message("events", { after: { camera: "side" } });
    const stats = message("stats", { cpu: 1 });
    send(front, message("back/motion"), event, stats);
    flush();
    expect(result.current.messages).toEqual([front, event, stats]);
  });

  it("passes everything with an empty filter", () => {
    const { result } = renderHook(() => useWsMessageBuffer(10, false, {}));
    const back = message("back/motion");
    send(back);
    flush();
    expect(result.current.messages).toEqual([back]);
  });

  it("clears the buffer immediately", () => {
    const { result } = renderHook(() => useWsMessageBuffer());
    send(message("front/motion"));
    flush();
    expect(result.current.messages).toHaveLength(1);
    act(() => result.current.clear());
    expect(result.current.messages).toEqual([]);
  });

  it("stops the batch timer on unmount", () => {
    const clear = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderHook(() => useWsMessageBuffer());
    unmount();
    expect(clear).toHaveBeenCalled();
  });
});
