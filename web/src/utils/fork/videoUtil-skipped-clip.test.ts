import { describe, expect, it } from "vitest";
import { calculateSeekPosition } from "@/utils/videoUtil";
import { Recording } from "@/types/record";

// B43 (upstream #24793): the vod manifest skips a clip whose audio ended
// before its window, and the realized timeline reports it with duration 0
function segment(start: number, end: number, duration: number): Recording {
  return {
    id: `${start}`,
    camera: "front_door",
    start_time: start,
    end_time: end,
    path: `/media/${start}.mp4`,
    segment_size: 1,
    duration,
    motion: 0,
    objects: 0,
    dBFS: 0,
  };
}

describe("calculateSeekPosition with skipped clips", () => {
  const recordings = [
    segment(1000, 1010, 10),
    segment(1010, 1020, 0),
    segment(1020, 1030, 10),
  ];

  it("lands a seek inside a skipped clip on the next clip that plays", () => {
    expect(calculateSeekPosition(1015, recordings)).toBe(10);
  });

  it("does not count the skipped clip before a later seek", () => {
    expect(calculateSeekPosition(1025, recordings)).toBe(15);
  });

  it("still seeks inside clips that play", () => {
    expect(calculateSeekPosition(1004, recordings)).toBe(4);
  });
});
