import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectCameraAudioFeatures,
  getPlaybackAudioCodecs,
  getStreamVideoCodecs,
} from "@/utils/cameraUtil";
import { LiveStreamMetadata } from "@/types/live";

function producer(medias: string[] | undefined) {
  return {
    type: "RTSP",
    url: "",
    remote_addr: "",
    user_agent: "",
    sdp: "",
    recv: 0,
    medias,
  };
}

const meta = (value: unknown) => value as LiveStreamMetadata;

function metadata(...producers: (string[] | undefined)[]): LiveStreamMetadata {
  return meta({ producers: producers.map(producer), consumers: [] });
}

// go2rtc can omit the producer list entirely while a stream is starting.
const NO_PRODUCERS = meta({ consumers: [] });

afterEach(() => vi.unstubAllGlobals());

describe("getStreamVideoCodecs", () => {
  it("returns nothing without metadata or producers", () => {
    expect(getStreamVideoCodecs(undefined)).toEqual([]);
    expect(getStreamVideoCodecs(null)).toEqual([]);
    expect(getStreamVideoCodecs(NO_PRODUCERS)).toEqual([]);
    expect(getStreamVideoCodecs(metadata(undefined))).toEqual([]);
  });

  it("collects unique video codecs in any direction and ignores audio", () => {
    expect(
      getStreamVideoCodecs(
        metadata(
          [" Video, recvonly, h264", "audio, recvonly, OPUS/48000/2"],
          ["video, sendonly, H265, H264"],
          ["video, VP9"],
        ),
      ),
    ).toEqual(["H264", "H265", "VP9"]);
  });
});

describe("getPlaybackAudioCodecs", () => {
  it("returns nothing without metadata or producers", () => {
    expect(getPlaybackAudioCodecs(undefined)).toEqual([]);
    expect(getPlaybackAudioCodecs(NO_PRODUCERS)).toEqual([]);
  });

  it("keeps recvonly and sendrecv audio and strips the clock rate", () => {
    expect(
      getPlaybackAudioCodecs(
        metadata(
          ["audio, recvonly, opus/48000/2", "audio, SendRecv, PCMA/8000"],
          ["audio, recvonly, OPUS/48000/2"],
        ),
      ),
    ).toEqual(["OPUS", "PCMA"]);
  });

  it("skips the talk backchannel, missing directions and video lines", () => {
    expect(
      getPlaybackAudioCodecs(
        metadata([
          "audio, sendonly, PCMU/8000",
          "audio, AAC/16000",
          "video, recvonly, H264",
        ]),
      ),
    ).toEqual([]);
  });
});

describe("detectCameraAudioFeatures", () => {
  it("reports no features when metadata or producers are missing", () => {
    expect(detectCameraAudioFeatures(undefined)).toEqual({
      twoWayAudio: false,
      audioOutput: false,
    });
    expect(detectCameraAudioFeatures(NO_PRODUCERS, false)).toEqual({
      twoWayAudio: false,
      audioOutput: false,
    });
  });

  it("detects talk and playback audio and skips producers without medias", () => {
    const meta = metadata(undefined, [
      "audio, sendonly, PCMU/8000",
      "audio, recvonly, OPUS/48000/2",
    ]);
    expect(detectCameraAudioFeatures(meta, false)).toEqual({
      twoWayAudio: true,
      audioOutput: true,
    });
  });

  it("requires a secure context for two-way talk unless told otherwise", () => {
    const meta = metadata(["audio, sendonly, PCMU/8000"]);
    vi.stubGlobal("isSecureContext", false);
    expect(detectCameraAudioFeatures(meta)).toEqual({
      twoWayAudio: false,
      audioOutput: false,
    });
    vi.stubGlobal("isSecureContext", true);
    expect(detectCameraAudioFeatures(meta).twoWayAudio).toBe(true);
  });
});
