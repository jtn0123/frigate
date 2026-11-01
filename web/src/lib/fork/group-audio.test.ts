import { describe, expect, it } from "vitest";
import type { CameraStreamingSettings } from "@/types/frigateConfig";
import { groupAudioStates } from "./group-audio";

function camera(playAudio: boolean, volume: number): CameraStreamingSettings {
  return {
    streamName: "main",
    streamType: "smart",
    compatibilityMode: false,
    playAudio,
    volume,
  };
}

describe("groupAudioStates", () => {
  it("reads the group's own audio and volume per camera", () => {
    expect(
      groupAudioStates({ front: camera(true, 0.4), back: camera(false, 1) }),
    ).toEqual({
      audio: { front: true, back: false },
      volume: { front: 0.4, back: 1 },
    });
  });

  it("starts muted at full volume when a setting is missing", () => {
    expect(groupAudioStates({ front: { streamName: "main" } })).toEqual({
      audio: { front: false },
      volume: { front: 1 },
    });
  });

  it("has nothing for a group without saved settings", () => {
    expect(groupAudioStates(undefined)).toEqual({ audio: {}, volume: {} });
  });
});
