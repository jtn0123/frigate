import { describe, expect, it } from "vitest";
import {
  buildFfmpegUrl,
  parseFfmpegBaseAndExtras,
  parseFfmpegUrl,
  toggleFfmpegMode,
} from "@/utils/go2rtcFfmpeg";

describe("parseFfmpegUrl", () => {
  it("passes non-ffmpeg urls through", () => {
    expect(parseFfmpegUrl("rtsp://cam/1")).toEqual({
      isFfmpeg: false,
      baseUrl: "rtsp://cam/1",
      videos: [],
      audios: [],
      hardware: "none",
      extraFragments: [],
    });
  });

  it("splits fallback chains, hardware and unknown fragments", () => {
    expect(
      parseFfmpegUrl(
        "ffmpeg:rtsp://cam/1#video=copy#video=h264#audio=opus#hardware=vaapi#timeout=10#video=vp9",
      ),
    ).toEqual({
      isFfmpeg: true,
      baseUrl: "rtsp://cam/1",
      videos: ["copy", "h264"],
      audios: ["opus"],
      hardware: "vaapi",
      extraFragments: ["timeout=10", "video=vp9"],
    });
  });

  it("uses exclude sentinels and auto hardware", () => {
    const parsed = parseFfmpegUrl("ffmpeg:cam#hardware#hardware=bogus");
    expect(parsed.videos).toEqual(["exclude"]);
    expect(parsed.audios).toEqual(["exclude"]);
    expect(parsed.hardware).toBe("auto");
    expect(parsed.extraFragments).toEqual(["hardware=bogus"]);
  });
});

describe("parseFfmpegBaseAndExtras", () => {
  it("drops recognized fragments with or without the prefix", () => {
    expect(
      parseFfmpegBaseAndExtras(
        "ffmpeg:rtsp://cam#video=h265#audio=aac#hardware#hardware=cuda#timeout=5#audio=flac#hardware=bad",
      ),
    ).toEqual({
      baseUrl: "rtsp://cam",
      extraFragments: ["timeout=5", "audio=flac", "hardware=bad"],
    });
    expect(parseFfmpegBaseAndExtras("rtsp://cam")).toEqual({
      baseUrl: "rtsp://cam",
      extraFragments: [],
    });
  });
});

describe("buildFfmpegUrl", () => {
  it("emits tracks, hardware and extras in order", () => {
    expect(
      buildFfmpegUrl({
        isFfmpeg: true,
        baseUrl: "rtsp://cam",
        videos: ["copy", "exclude", "h264"],
        audios: ["aac"],
        hardware: "cuda",
        extraFragments: ["timeout=10"],
      }),
    ).toBe(
      "ffmpeg:rtsp://cam#video=copy#video=h264#audio=aac#hardware=cuda#timeout=10",
    );
  });

  it("skips excluded primaries and emits bare hardware for auto", () => {
    expect(
      buildFfmpegUrl({
        isFfmpeg: true,
        baseUrl: "cam",
        videos: ["exclude", "h264"],
        audios: ["exclude"],
        hardware: "auto",
        extraFragments: [],
      }),
    ).toBe("ffmpeg:cam#hardware");
  });

  it("round-trips a parsed url", () => {
    const url = "ffmpeg:cam#video=h264#audio=copy#audio=opus#hardware";
    expect(buildFfmpegUrl(parseFfmpegUrl(url))).toBe(url);
  });
});

describe("toggleFfmpegMode", () => {
  it("enables compat mode with copy tracks once", () => {
    expect(toggleFfmpegMode("rtsp://cam", true)).toBe(
      "ffmpeg:rtsp://cam#video=copy#audio=copy",
    );
    expect(toggleFfmpegMode("ffmpeg:rtsp://cam", true)).toBe(
      "ffmpeg:rtsp://cam",
    );
  });

  it("disables compat mode and keeps unknown fragments", () => {
    expect(
      toggleFfmpegMode(
        "ffmpeg:rtsp://cam#video=copy#timeout=10#hardware",
        false,
      ),
    ).toBe("rtsp://cam#timeout=10");
    expect(toggleFfmpegMode("rtsp://cam", false)).toBe("rtsp://cam");
  });
});
