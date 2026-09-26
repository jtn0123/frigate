import { describe, expect, it } from "vitest";
import i18next from "i18next";
import {
  ffprobeToTestResult,
  getStreamIssues,
  lastErrorLine,
  resolveRestreamSource,
} from "./streamIssues";
import type { StreamIssueInput } from "./streamIssues";

const t = i18next.t.bind(i18next);
const rules = (input: Partial<StreamIssueInput>) =>
  getStreamIssues({ url: "rtsp://camera/live", roles: [], ...input }, t).map(
    ({ rule, type }) => `${rule}:${type}`,
  );

describe("stream probe interpretation", () => {
  it("handles missing, failed and malformed probe responses", () => {
    for (const entry of [
      undefined,
      {},
      { return_code: 1, stderr: ["intro", "denied"] },
      { return_code: 0, stdout: "bad" },
      { return_code: 0, stdout: null },
    ]) {
      expect(ffprobeToTestResult(entry).success).toBe(false);
    }
    expect(ffprobeToTestResult({ stderr: " denied " }).error).toBe("denied");
    expect(ffprobeToTestResult({ stderr: ["intro", "denied"] }).error).toBe(
      "intro\ndenied",
    );
    expect(lastErrorLine(" intro\n \n denied \n")).toBe("denied");
    expect(lastErrorLine(undefined)).toBe("");
  });
  it("extracts video, audio and rational frame rates with codec fallbacks", () => {
    expect(
      ffprobeToTestResult({
        return_code: 0,
        stdout: {
          streams: [
            {
              codec_type: "video",
              codec_name: "hevc",
              width: 1920,
              height: 1080,
              avg_frame_rate: "30000/1001",
            },
            { codec_type: "audio", codec_name: "aac" },
          ],
        },
      }),
    ).toMatchObject({
      success: true,
      resolution: "1920x1080",
      videoCodec: "hevc",
      audioCodec: "aac",
      fps: 30000 / 1001,
    });
    for (const codec of ["h264", "h265"]) {
      expect(
        ffprobeToTestResult({
          return_code: 0,
          stdout: {
            streams: [{ codec_name: codec }, { codec_name: "mp3" }, {}],
          },
        }),
      ).toMatchObject({ success: true, videoCodec: codec, audioCodec: "mp3" });
    }
    for (const rate of ["0/1", "bad", undefined]) {
      expect(
        ffprobeToTestResult({
          return_code: 0,
          stdout: { streams: [{ codec_type: "video", avg_frame_rate: rate }] },
        }).fps,
      ).toBeUndefined();
    }
    expect(ffprobeToTestResult({ return_code: 0, stdout: {} })).toMatchObject({
      success: true,
      videoCodec: undefined,
      audioCodec: undefined,
    });
  });
});

describe("stream validation rules", () => {
  it.each([
    [{ brand: "reolink", url: "RTSP://camera/live" }, ["reolink-rtsp:warning"]],
    [{ brand: "reolink", url: "http://camera/live" }, ["reolink-http:warning"]],
    [{ brand: "reolink", url: "http://camera/live", useFfmpeg: true }, []],
    [
      { brand: "dahua", url: "rtsp://camera?subtype=1", roles: ["detect"] },
      ["dahua-substream:warning"],
    ],
    [
      { brand: "hikvision", url: "rtsp://camera/102", roles: ["detect"] },
      ["hikvision-substream:warning"],
    ],
    [{ roles: ["record"] }, ["no-audio:warning"]],
    [{ roles: ["audio"] }, ["audio-required:error"]],
    [
      {
        roles: ["record"],
        restream: true,
        testResult: { success: true, audioCodec: "AAC" },
      },
      ["audio-codec:good", "restream:warning"],
    ],
    [
      { roles: ["record"], testResult: { success: true, audioCodec: "pcm" } },
      ["audio-codec-record:error"],
    ],
  ] satisfies [Partial<StreamIssueInput>, string[]][])(
    "applies only matching rules: %j",
    (input, expected) => {
      expect(rules(input)).toEqual(expected);
    },
  );
  it.each(["H264", "h265", "hevc"])(
    "accepts recording video codec %s",
    (videoCodec) => {
      expect(rules({ testResult: { success: true, videoCodec } })).toEqual([
        "video-codec:good",
      ]);
    },
  );
  it.each([
    [undefined, "resolution-unknown:error"],
    ["bad", "resolution-unknown:error"],
    ["0x720", "resolution-unknown:error"],
    ["3840x2160", "resolution-high:warning"],
    ["320x240", "resolution-low:error"],
    ["1920x1080", undefined],
    ["720x1280", undefined],
  ])("checks detection dimensions %s", (resolution, issue) => {
    expect(
      rules({ roles: ["detect"], testResult: { success: true, resolution } }),
    ).toEqual(issue ? [issue] : []);
  });
  it("does not apply brand rules to other roles or main streams", () => {
    expect(rules({ brand: "dahua", url: "rtsp://camera?subtype=1" })).toEqual(
      [],
    );
    expect(
      rules({
        brand: "hikvision",
        url: "rtsp://camera/101",
        roles: ["detect"],
      }),
    ).toEqual([]);
    expect(
      rules({ testResult: { success: false, videoCodec: "unknown" } }),
    ).toEqual([]);
  });
});

describe("restream source resolution", () => {
  const path = "rtsp://127.0.0.1:8554/front";
  it("resolves original sources while skipping self-referential ffmpeg links", () => {
    expect(
      resolveRestreamSource(path, {
        front: ["ffmpeg:front#audio=aac", "rtsp://camera/live"],
      }),
    ).toEqual({ url: "rtsp://camera/live", useFfmpeg: false });
    expect(
      resolveRestreamSource(path, {
        front: "ffmpeg:http://camera/live#video=copy",
      }),
    ).toEqual({ url: "http://camera/live", useFfmpeg: true });
    expect(
      resolveRestreamSource(path, { front: "rtsp://camera/live" }),
    ).toEqual({ url: "rtsp://camera/live", useFfmpeg: false });
  });
  it("returns no source for missing configs or loops", () => {
    expect(resolveRestreamSource("rtsp://camera/live", {})).toBeUndefined();
    expect(resolveRestreamSource(path, undefined)).toBeUndefined();
    expect(resolveRestreamSource(path, {})).toBeUndefined();
    expect(
      resolveRestreamSource(path, { front: ["ffmpeg:front#audio=aac"] }),
    ).toBeUndefined();
  });
});
