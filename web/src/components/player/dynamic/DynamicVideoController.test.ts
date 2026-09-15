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
});
