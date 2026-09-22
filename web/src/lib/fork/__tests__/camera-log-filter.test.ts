import { describe, expect, it } from "vitest";
import { matchesCameraLog } from "../camera-log-filter";

describe("camera log filter", () => {
  it("matches camera logger names and camera mentions", () => {
    expect(
      matchesCameraLog(
        "ffmpeg.front_door.detect ERROR lost stream",
        "front_door",
      ),
    ).toBe(true);
    expect(matchesCameraLog("Camera FRONT_DOOR failed", "front_door")).toBe(
      true,
    );
  });
  it("excludes other cameras and similar identifiers", () => {
    expect(
      matchesCameraLog("ffmpeg.front_door_2.detect ERROR", "front_door"),
    ).toBe(false);
    expect(matchesCameraLog("ffmpeg.backyard.detect ERROR", "front_door")).toBe(
      false,
    );
  });
  it("prefers a camera-specific logger even when its message mentions another camera", () => {
    expect(
      matchesCameraLog(
        "[2026-04-06 10:00:00] ffmpeg.garage_2.detect ERROR: Other garage failed",
        "garage",
      ),
    ).toBe(false);
    expect(
      matchesCameraLog(
        "[2026-04-06 10:00:00] watchdog.garage ERROR: Stream failed",
        "garage",
      ),
    ).toBe(true);
  });
  it("does not mistake a logger prefix or role for a camera", () => {
    for (const camera of ["ffmpeg", "watchdog", "video", "detect"]) {
      expect(
        matchesCameraLog(
          "[2026-04-06 10:00:00] ffmpeg.backyard.detect ERROR: Stream failed",
          camera,
        ),
      ).toBe(false);
    }
  });
  it("treats special characters literally and an empty filter as all lines", () => {
    expect(matchesCameraLog("ffmpeg.garage[1].detect", "garage[1]")).toBe(true);
    expect(matchesCameraLog("ffmpeg.garage1.detect", "garage[1]")).toBe(false);
    expect(matchesCameraLog("all logs", "")).toBe(true);
  });
});
