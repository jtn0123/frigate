import { describe, expect, it } from "vitest";
import type { FrigateConfig, LiveTranscodeConfig } from "@/types/frigateConfig";
import {
  defaultTranscodeBitrate,
  isRestreamedStream,
  isTranscodeStreamName,
  reconcileTranscodeStreams,
  transcodeBitrateFor,
  transcodeStreamName,
} from "./liveTranscode";

const cfg = (value: unknown) => value as FrigateConfig;

const transcode = (enabled: boolean): LiveTranscodeConfig =>
  ({
    enabled,
    source: "front_main",
    qualities: [
      { height: 720, bitrate: 1200 },
      { height: 360, bitrate: 300 },
    ],
  }) as LiveTranscodeConfig;

describe("liveTranscode", () => {
  it("names and recognizes generated streams", () => {
    expect(transcodeStreamName("front", 720)).toBe("front_transcode_720p");
    expect(isTranscodeStreamName("front", "front_transcode_720p")).toBe(true);
    expect(isTranscodeStreamName("front", "front_transcode_hd")).toBe(false);
    expect(isTranscodeStreamName("front", "back_transcode_720p")).toBe(false);
  });

  it("falls back to 500 kbps for heights without a default", () => {
    expect(defaultTranscodeBitrate(1080)).toBe(2500);
    expect(defaultTranscodeBitrate(900)).toBe(500);
  });

  it("returns a generated stream's bitrate only while transcoding is on", () => {
    expect(
      transcodeBitrateFor("front", "front_transcode_360p", transcode(true)),
    ).toBe(300);
    expect(
      transcodeBitrateFor("front", "front_main", transcode(true)),
    ).toBeUndefined();
    expect(
      transcodeBitrateFor("front", "front_transcode_360p", transcode(false)),
    ).toBeUndefined();
    expect(
      transcodeBitrateFor("front", "front_transcode_360p", undefined),
    ).toBeUndefined();
  });

  it("appends missing generated streams and keeps placed ones", () => {
    expect(
      reconcileTranscodeStreams(
        "front",
        { Low: "front_transcode_360p", Main: "front_main" },
        transcode(true),
        ["front_main"],
      ),
    ).toEqual({
      Low: "front_transcode_360p",
      Main: "front_main",
      "720p": "front_transcode_720p",
    });
  });

  it("drops stale generated streams but keeps go2rtc ones of that name", () => {
    expect(
      reconcileTranscodeStreams(
        "front",
        {
          Main: "front_main",
          Old: "front_transcode_1080p",
          Kept: "front_transcode_240p",
        },
        transcode(false),
        ["front_main", "front_transcode_240p"],
      ),
    ).toEqual({ Main: "front_main", Kept: "front_transcode_240p" });
  });

  it("leaves a taken label for the backend to reject", () => {
    expect(
      reconcileTranscodeStreams(
        "front",
        { "720p": "front_main" },
        transcode(true),
        ["front_main"],
      ),
    ).toEqual({ "720p": "front_main", "360p": "front_transcode_360p" });
  });

  it("knows which streams go2rtc serves", () => {
    const config = cfg({
      go2rtc: { streams: { front_main: ["rtsp://x"] } },
      cameras: {
        front: { name: "front", live: { transcode: transcode(true) } },
        back: { name: "back", live: { transcode: transcode(false) } },
      },
    });
    expect(isRestreamedStream(undefined, "front_main")).toBe(false);
    expect(isRestreamedStream(config, undefined)).toBe(false);
    expect(isRestreamedStream(config, "front_main")).toBe(true);
    expect(isRestreamedStream(config, "front_transcode_720p")).toBe(true);
    expect(isRestreamedStream(config, "back_transcode_720p")).toBe(false);
    expect(isRestreamedStream(cfg({ ...config, go2rtc: {} }), "other")).toBe(
      false,
    );
  });
});
