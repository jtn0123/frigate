import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import {
  getWsTopicValue,
  invalidateCameraActivityCache,
  processWsMessage,
  resetWsStore,
  subscribeWsTopic,
  useEnabledState,
  useWs,
  useWsMessageSubscribe,
  useWsUpdate,
} from "./ws";
import { WsSendContext, type WsSend } from "./wsContext";

const message = (topic: string, payload: unknown) =>
  JSON.stringify({ topic, payload, retain: false });

const activity = (cameras: Record<string, unknown>) =>
  message("camera_activity", JSON.stringify(cameras));

const frontConfig = {
  enabled: true,
  detect: false,
  snapshots: false,
  record: true,
  audio: false,
  audio_transcription: false,
  notifications: true,
  notifications_suspended: 120,
  autotracking: false,
  alerts: true,
  detections: false,
  object_descriptions: false,
  review_descriptions: true,
};

function withSend(send: WsSend) {
  return ({ children }: { children: ReactNode }) =>
    createElement(WsSendContext.Provider, { value: send }, children);
}

beforeEach(() => {
  resetWsStore();
});

afterEach(() => {
  resetWsStore();
});

describe("processWsMessage", () => {
  it("stores the payload and notifies topic listeners", () => {
    const listener = vi.fn();
    subscribeWsTopic("front/motion", listener);
    processWsMessage(message("front/motion", "ON"));
    expect(getWsTopicValue("front/motion")).toBe("ON");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getWsTopicValue("unknown")).toBeUndefined();
  });

  it("skips notification when a primitive value is unchanged", () => {
    const listener = vi.fn();
    subscribeWsTopic("front/motion", listener);
    processWsMessage(message("front/motion", "ON"));
    processWsMessage(message("front/motion", "ON"));
    processWsMessage(message("front/motion", "OFF"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("uses deep equality for object payloads", () => {
    const listener = vi.fn();
    subscribeWsTopic("stats", listener);
    processWsMessage(message("stats", { cpu: 1 }));
    processWsMessage(message("stats", { cpu: 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
    processWsMessage(message("stats", { cpu: 2 }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getWsTopicValue("stats")).toEqual({ cpu: 2 });
  });

  it("ignores a null frame", () => {
    expect(() => processWsMessage("null")).not.toThrow();
  });

  it("supports unsubscribing, also from inside a notification", () => {
    const second = vi.fn();
    const first = vi.fn(() => unsubscribeFirst());
    const unsubscribeFirst = subscribeWsTopic("t", first);
    const unsubscribeSecond = subscribeWsTopic("t", second);

    processWsMessage(message("t", 1));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    processWsMessage(message("t", 2));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    unsubscribeSecond();
    processWsMessage(message("t", 3));
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("resetWsStore clears values and listeners", () => {
    const listener = vi.fn();
    subscribeWsTopic("t", listener);
    processWsMessage(message("t", 1));
    resetWsStore();
    expect(getWsTopicValue("t")).toBeUndefined();
    processWsMessage(message("t", 2));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("camera_activity expansion", () => {
  it("expands the snapshot into per-camera state topics", () => {
    processWsMessage(
      activity({ front: { config: frontConfig, motion: false, objects: [] } }),
    );
    expect(getWsTopicValue("camera_activity/front")).toEqual({
      config: frontConfig,
      motion: false,
      objects: [],
    });
    expect(getWsTopicValue("front/recordings/state")).toBe("ON");
    expect(getWsTopicValue("front/enabled/state")).toBe("ON");
    expect(getWsTopicValue("front/detect/state")).toBe("OFF");
    expect(getWsTopicValue("front/snapshots/state")).toBe("OFF");
    expect(getWsTopicValue("front/audio/state")).toBe("OFF");
    expect(getWsTopicValue("front/audio_transcription/state")).toBe("OFF");
    expect(getWsTopicValue("front/notifications/state")).toBe("ON");
    expect(getWsTopicValue("front/notifications/suspended")).toBe("120");
    expect(getWsTopicValue("front/ptz_autotracker/state")).toBe("OFF");
    expect(getWsTopicValue("front/review_alerts/state")).toBe("ON");
    expect(getWsTopicValue("front/review_detections/state")).toBe("OFF");
    expect(getWsTopicValue("front/object_descriptions/state")).toBe("OFF");
    expect(getWsTopicValue("front/review_descriptions/state")).toBe("ON");
  });

  it("defaults a missing suspension to 0 and skips cameras without config", () => {
    const { notifications_suspended: _omit, ...rest } = frontConfig;
    processWsMessage(
      activity({ front: { config: rest }, back: { motion: true } }),
    );
    expect(getWsTopicValue("front/notifications/suspended")).toBe("0");
    expect(getWsTopicValue("camera_activity/back")).toEqual({ motion: true });
    expect(getWsTopicValue("back/detect/state")).toBeUndefined();
  });

  it("skips byte-identical snapshots until the cache is invalidated", () => {
    const listener = vi.fn();
    subscribeWsTopic("camera_activity/front", listener);
    const frame = activity({ front: { config: frontConfig } });
    processWsMessage(frame);
    processWsMessage(frame);
    expect(listener).toHaveBeenCalledTimes(1);

    invalidateCameraActivityCache();
    processWsMessage(frame);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("always re-notifies activity snapshot listeners even when unchanged", () => {
    const listener = vi.fn();
    subscribeWsTopic("camera_activity/front", listener);
    processWsMessage(activity({ front: { config: frontConfig } }));
    processWsMessage(activity({ front: { config: frontConfig }, back: {} }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed and empty snapshots", () => {
    expect(() =>
      processWsMessage(message("camera_activity", "{oops")),
    ).not.toThrow();
    processWsMessage(message("camera_activity", "{}"));
    expect(getWsTopicValue("camera_activity/front")).toBeUndefined();
  });
});

describe("hooks", () => {
  it("useWs subscribes to a topic and publishes through the context", () => {
    const send = vi.fn();
    const { result } = renderHook(
      () => useWs("front/detect/state", "front/detect/set"),
      { wrapper: withSend(send) },
    );
    expect(result.current.value.payload).toBeNull();

    act(() => {
      processWsMessage(message("front/detect/state", "ON"));
    });
    expect(result.current.value.payload).toBe("ON");

    result.current.send("OFF");
    expect(send).toHaveBeenCalledWith({
      topic: "front/detect/set",
      payload: "OFF",
      retain: false,
    });
  });

  it("useWs falls back to the watch topic when no publish topic is given", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useWs("restart", ""), {
      wrapper: withSend(send),
    });
    result.current.send("go", true);
    expect(send).toHaveBeenCalledWith({
      topic: "restart",
      payload: "go",
      retain: true,
    });
  });

  it("useEnabledState derives its topics from the camera name", () => {
    const send = vi.fn();
    processWsMessage(message("back/enabled/state", "OFF"));
    const { result } = renderHook(() => useEnabledState("back"), {
      wrapper: withSend(send),
    });
    expect(result.current.payload).toBe("OFF");
    result.current.send("ON");
    expect(send).toHaveBeenCalledWith({
      topic: "back/enabled/set",
      payload: "ON",
      retain: false,
    });
  });

  it("useWsUpdate throws outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useWsUpdate())).toThrow(/WsProvider/);
  });

  it("useWsMessageSubscribe receives every frame with sequential ids", () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useWsMessageSubscribe(callback));
    processWsMessage(message("a", 1));
    processWsMessage(message("b", 2));
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[0][0]).toMatchObject({
      topic: "a",
      payload: 1,
      id: "0",
    });
    expect(callback.mock.calls[1][0]).toMatchObject({
      topic: "b",
      payload: 2,
      id: "1",
    });
    expect(typeof callback.mock.calls[0][0].timestamp).toBe("number");

    unmount();
    processWsMessage(message("c", 3));
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
