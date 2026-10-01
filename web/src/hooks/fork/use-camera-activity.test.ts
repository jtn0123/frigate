import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraConfig } from "@/types/frigateConfig";
import type { MotionData, ReviewSegment } from "@/types/review";
import {
  useCameraActivity,
  useCameraMotionNextTimestamp,
  useCameraMotionOnlyRanges,
} from "@/hooks/use-camera-activity";

type EventPayload = {
  type: "new" | "update" | "end";
  after: Record<string, unknown>;
};

const fx = vi.hoisted(() => ({
  config: undefined as unknown,
  cameraState: undefined as unknown,
  audio: undefined as unknown,
  enabled: undefined as string | undefined,
  motion: undefined as string | undefined,
  event: undefined as EventPayload | undefined,
  stats: undefined as unknown,
}));

vi.mock("swr", () => ({ default: () => ({ data: fx.config }) }));
vi.mock("@/api/ws", () => ({
  useInitialCameraState: () => ({ payload: fx.cameraState }),
  useAudioDetections: () => ({ payload: fx.audio }),
  useEnabledState: () => ({ payload: fx.enabled }),
  useMotionActivity: () => ({ payload: fx.motion }),
  useFrigateEvents: () => ({ payload: fx.event }),
}));
vi.mock("@/hooks/use-stats", () => ({
  useAutoFrigateStats: () => fx.stats,
}));

const camera = { name: "front" } as CameraConfig;

function object(id: string, label = "person", stationary = false) {
  return {
    id,
    label,
    stationary,
    area: 10,
    ratio: 1,
    score: 0.9,
    sub_label: "",
  };
}

function event(
  type: EventPayload["type"],
  after: Record<string, unknown>,
): EventPayload {
  return {
    type,
    after: {
      camera: "front",
      label: "person",
      stationary: false,
      area: 10,
      ratio: 1,
      score: 0.9,
      sub_label: null,
      ...after,
    },
  };
}

beforeEach(() => {
  fx.config = undefined;
  fx.cameraState = undefined;
  fx.audio = undefined;
  fx.enabled = undefined;
  fx.motion = undefined;
  fx.event = undefined;
  fx.stats = undefined;
});

describe("useCameraActivity", () => {
  it("is idle and enabled by default", () => {
    const { result } = renderHook(() => useCameraActivity(camera));
    expect(result.current).toEqual({
      enabled: true,
      activeTracking: false,
      activeMotion: false,
      objects: [],
      audio_detections: [],
      offline: false,
    });
  });

  it("seeds objects, motion and audio from the camera snapshot", () => {
    fx.cameraState = {
      motion: true,
      objects: [object("a"), object("b", "car", true)],
    };
    fx.audio = { front: [{ id: "s", label: "speech", score: 0.8 }], back: [] };
    const { result } = renderHook(() => useCameraActivity(camera));
    expect(result.current.objects.map((o) => o.id)).toEqual(["a", "b"]);
    expect(result.current.activeTracking).toBe(true);
    expect(result.current.activeMotion).toBe(true);
    expect(result.current.audio_detections).toEqual([
      { id: "s", label: "speech", score: 0.8 },
    ]);
  });

  it("does not track when every object is stationary", () => {
    fx.cameraState = { objects: [object("b", "car", true)] };
    const { result } = renderHook(() => useCameraActivity(camera));
    expect(result.current.activeTracking).toBe(false);
  });

  it("prefers the live motion topic over the snapshot", () => {
    fx.cameraState = { motion: true, objects: [] };
    fx.motion = "OFF";
    const { result, rerender } = renderHook(() => useCameraActivity(camera));
    expect(result.current.activeMotion).toBe(false);
    fx.motion = "ON";
    rerender();
    expect(result.current.activeMotion).toBe(true);
  });

  it("hides all activity while the camera is disabled", () => {
    fx.cameraState = { motion: true, objects: [object("a")] };
    fx.audio = { front: [{ id: "s", label: "speech", score: 0.8 }] };
    fx.enabled = "OFF";
    const { result } = renderHook(() => useCameraActivity(camera));
    expect(result.current).toMatchObject({
      enabled: false,
      activeTracking: false,
      activeMotion: false,
      objects: [],
      audio_detections: [],
    });
  });

  it("applies new, update and end events for this camera", () => {
    fx.config = {
      models: [{ attributes_map: { car: ["amazon"] } }],
    };
    const { result, rerender } = renderHook(() => useCameraActivity(camera));

    // stationary unknown objects are not added
    fx.event = event("new", { id: "parked", stationary: true });
    rerender();
    expect(result.current.objects).toEqual([]);

    fx.event = event("new", { id: "p1" });
    rerender();
    expect(result.current.objects).toEqual([
      { ...object("p1"), sub_label: "" },
    ]);

    // a recognized sub label becomes a verified label
    fx.event = event("update", { id: "p1", sub_label: ["bob", 0.9] });
    rerender();
    expect(result.current.objects[0]?.label).toBe("person-verified");

    // an attribute sub label replaces the label
    fx.event = event("new", {
      id: "c1",
      label: "car",
      sub_label: ["amazon", 0.8],
    });
    rerender();
    expect(result.current.objects[1]).toMatchObject({
      id: "c1",
      label: "amazon",
      sub_label: "amazon",
    });

    // an unchanged update keeps the same list
    const before = result.current.objects;
    fx.event = event("update", { id: "p1", sub_label: ["bob", 0.95] });
    rerender();
    expect(result.current.objects).toBe(before);

    fx.event = event("update", {
      id: "p1",
      sub_label: ["bob", 0.95],
      stationary: true,
    });
    rerender();
    expect(result.current.objects[0]?.stationary).toBe(true);
    // the car is still moving
    expect(result.current.activeTracking).toBe(true);

    fx.event = event("end", { id: "p1" });
    rerender();
    expect(result.current.objects.map((o) => o.id)).toEqual(["c1"]);

    // ending an unknown object is a no-op
    const remaining = result.current.objects;
    fx.event = event("end", { id: "ghost" });
    rerender();
    expect(result.current.objects).toBe(remaining);
  });

  it("ignores events for other cameras and without a camera", () => {
    fx.event = event("new", { id: "x", camera: "back" });
    const { result } = renderHook(() => useCameraActivity(camera));
    expect(result.current.objects).toEqual([]);

    const unnamed = renderHook(() => useCameraActivity(undefined));
    expect(unnamed.result.current.objects).toEqual([]);
  });

  it("reports offline when the camera has no fps after startup", () => {
    const stats = (fps: number, uptime: number) => ({
      cameras: { front: { camera_fps: fps } },
      service: { uptime },
    });

    fx.stats = stats(0, 120);
    const { result, rerender } = renderHook(
      ({ cam }) => useCameraActivity(cam),
      { initialProps: { cam: camera as CameraConfig | undefined } },
    );
    expect(result.current.offline).toBe(true);

    fx.stats = stats(0, 30);
    rerender({ cam: camera });
    expect(result.current.offline).toBe(false);

    fx.stats = stats(5, 120);
    rerender({ cam: camera });
    expect(result.current.offline).toBe(false);

    fx.stats = { service: { uptime: 120 } };
    rerender({ cam: camera });
    expect(result.current.offline).toBe(false);

    fx.stats = stats(0, 120);
    rerender({ cam: undefined });
    expect(result.current.offline).toBe(false);
  });
});

function motion(start: number, value: number): MotionData {
  return { start_time: start, motion: value, camera: "front" };
}

function review(start_time: number, end_time?: number): ReviewSegment {
  return {
    id: `r${start_time}`,
    camera: "front",
    severity: "alert",
    start_time,
    ...(end_time === undefined ? {} : { end_time }),
    thumb_path: "",
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: [],
      objects: [],
      significant_motion_areas: [],
      zones: [],
    },
  };
}

describe("useCameraMotionNextTimestamp", () => {
  // 15s motion buckets over 30s segments
  const B = 1500;
  const data = [0, 0, 5, 0, 0, 0, 4, 0, 0, 0].map((value, i) =>
    motion(B + i * 15, value),
  );

  function next(
    currentTime: number,
    motionOnly = true,
    reviews: ReviewSegment[] = [],
    motionData = data,
  ) {
    return renderHook(() =>
      useCameraMotionNextTimestamp(
        B,
        30,
        motionOnly,
        reviews,
        motionData,
        B + currentTime,
      ),
    ).result.current;
  }

  it("is undefined without motion data", () => {
    expect(next(10, true, [], [])).toBeUndefined();
  });

  it("advances half a second when not skipping", () => {
    expect(next(10, false)).toBe(B + 10.5);
  });

  it("skips past ranges without motion", () => {
    // no-motion ranges are [0, 30), [60, 90) and [120, 150) past B
    expect(next(5)).toBe(B + 30);
    expect(next(40)).toBe(B + 40.5);
    expect(next(59.8)).toBe(B + 60);
    expect(next(70)).toBe(B + 90);
    expect(next(125)).toBe(B + 150);
  });

  it("skips a no-motion range that starts at timestamp 0", () => {
    // the range search destructures each range on every pass; cap that so a
    // search that stops advancing fails here instead of hanging the run
    const iterate = Array.prototype[Symbol.iterator];
    let passes = 0;
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      passes += 1;
      if (passes > 100_000) {
        throw new Error("range search did not advance");
      }
      return iterate.call(this);
    };
    try {
      const zeroData = data.map((m) => ({
        ...m,
        start_time: m.start_time - B,
      }));
      const result = renderHook(() =>
        useCameraMotionNextTimestamp(0, 30, true, [], zeroData, 5),
      ).result.current;
      expect(result).toBe(30);
    } finally {
      Array.prototype[Symbol.iterator] = iterate;
    }
  });

  it("treats segments covered by review items as skippable", () => {
    expect(next(35, true, [review(B + 30, B + 40)])).toBe(B + 90);
    // an ongoing review item runs until now
    expect(next(95, true, [review(B + 80)])).toBe(B + 150);
  });
});

describe("useCameraMotionOnlyRanges", () => {
  function ranges(
    motionData: MotionData[],
    reviews: ReviewSegment[] = [],
    segmentDuration = 30,
  ) {
    return renderHook(() =>
      useCameraMotionOnlyRanges(segmentDuration, reviews, motionData),
    ).result.current;
  }

  it("is empty without data", () => {
    expect(ranges([])).toEqual([]);
    expect(ranges([motion(0, 0)])).toEqual([]);
  });

  it("merges contiguous motion buckets and dedupes start times", () => {
    expect(
      ranges([
        motion(30, 3),
        motion(0, 2),
        motion(15, 0),
        motion(15, 4),
        motion(60, 0),
        motion(90, 1),
      ]),
    ).toEqual([
      { start_time: 0, end_time: 45 },
      { start_time: 90, end_time: 105 },
    ]);
  });

  it("excludes buckets overlapping review items", () => {
    expect(
      ranges([motion(0, 1), motion(15, 1), motion(30, 1)], [review(16, 20)]),
    ).toEqual([
      { start_time: 0, end_time: 15 },
      { start_time: 30, end_time: 45 },
    ]);
  });

  it("uses at least a one second bucket", () => {
    expect(ranges([motion(0, 1)], [], 1)).toEqual([
      { start_time: 0, end_time: 1 },
    ]);
  });
});
