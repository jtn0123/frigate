import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "@/types/record";
import { PreviewController } from "../PreviewPlayer";
import { DynamicVideoController } from "./DynamicVideoController";

class StubPreviewController extends PreviewController {
  scrubToTimestamp(): boolean {
    return false;
  }

  finishedSeeking(): void {}

  setNewPreviewStartTime(): void {}
}

const HOUR = 1789000000;

function segment(start: number, end: number): Recording {
  return {
    id: `${start}`,
    camera: "front",
    start_time: start,
    end_time: end,
    path: "",
    segment_size: 1,
    duration: end - start,
    motion: 0,
    objects: 0,
    dBFS: 0,
  };
}

function setup() {
  const video = document.createElement("video");
  let position = 42;
  const seeks: number[] = [];
  Object.defineProperty(video, "currentTime", {
    get: () => position,
    set: (value: number) => {
      position = value;
      seeks.push(value);
    },
  });
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
  const setNoRecording = vi.fn();
  const controller = new DynamicVideoController(
    "front",
    video,
    new StubPreviewController("front"),
    0,
    "playback",
    setNoRecording,
    () => {},
  );
  controller.newPlayback({
    recordings: [segment(HOUR + 60, HOUR + 70), segment(HOUR + 70, HOUR + 80)],
    timeRange: { after: HOUR, before: HOUR + 3600 },
  });
  return { video, seeks, pause, setNoRecording, controller };
}

describe("DynamicVideoController.seekToTimestamp", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("seeks to position 0 at the first segment's start (UI90)", () => {
    const { controller, seeks, pause } = setup();

    controller.seekToTimestamp(HOUR + 60);

    expect(seeks).toEqual([0]);
    expect(pause).toHaveBeenCalled();
  });

  it("plays after a seek to position 0 when asked to (UI90)", () => {
    const { controller, video, seeks } = setup();
    const waitAndPlay = vi
      .spyOn(controller, "waitAndPlay")
      .mockResolvedValue(undefined);

    controller.seekToTimestamp(HOUR + 60, true);

    expect(seeks).toEqual([0]);
    expect(waitAndPlay).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(0);
  });

  it("seeks inside a later segment", () => {
    const { controller, seeks } = setup();

    controller.seekToTimestamp(HOUR + 75);

    expect(seeks).toEqual([15]);
  });

  it("plays from the first segment for a time before it (UI89)", () => {
    const { controller, seeks, pause, setNoRecording } = setup();

    controller.seekToTimestamp(HOUR + 30);

    expect(seeks).toEqual([0]);
    expect(pause).toHaveBeenCalled();
    expect(setNoRecording).not.toHaveBeenCalledWith(true);
  });

  it("clears no recordings once a later seek lands (UI89)", () => {
    const { controller, seeks, setNoRecording } = setup();

    controller.seekToTimestamp(HOUR + 100);
    expect(setNoRecording).toHaveBeenLastCalledWith(true);
    expect(seeks).toEqual([]);

    controller.seekToTimestamp(HOUR + 65);
    expect(seeks).toEqual([5]);
    expect(setNoRecording).toHaveBeenLastCalledWith(false);
  });
});

it("maps keyframe lead-in and clamps progress past the final segment", () => {
  const { controller } = setup();
  controller.newPlayback({
    recordings: [{ ...segment(100, 110), duration: 12 }, segment(120, 130)],
    timeRange: { after: 100, before: 130 },
  });
  expect(controller.getProgress(1)).toBe(100);
  expect(controller.getProgress(7)).toBe(105);
  expect(controller.getProgress(14)).toBe(122);
  expect(controller.getProgress(99)).toBe(130);
  controller.newPlayback({
    recordings: [],
    timeRange: { after: 100, before: 130 },
  });
  expect(controller.getProgress(5)).toBe(0);
});
it("honors play intent at the current position without waiting for a seek event", async () => {
  const { controller, video, pause } = setup();
  const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
  video.currentTime = 0;
  controller.seekToTimestamp(HOUR + 60, true);
  await Promise.resolve();
  expect(play).toHaveBeenCalledOnce();
  controller.seekToTimestamp(HOUR + 60, false);
  expect(pause).toHaveBeenCalled();
});
it("ignores seeks outside its playback window and pauses when previews are unavailable", () => {
  const { controller, seeks, pause } = setup();
  controller.seekToTimestamp(HOUR - 1);
  controller.seekToTimestamp(HOUR + 3601);
  expect(seeks).toEqual([]);
  controller.scrubToTimestamp(HOUR + 70, true);
  expect(pause).toHaveBeenCalledOnce();
  controller.scrubToTimestamp(HOUR + 71);
  expect(pause).toHaveBeenCalledOnce();
});
