import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateStreamWebRTCAvailability } from "@/hooks/use-webrtc-availability";
import { LiveStreamMetadata } from "@/types/live";
import {
  browserWebRTCVideoCodecs,
  parseWebRTCMessage,
  webRTCIceServers,
} from "@/utils/webrtcUtil";

function metadata(medias: string[]): LiveStreamMetadata {
  return {
    producers: [
      {
        type: "RTSP",
        url: "",
        remote_addr: "",
        user_agent: "",
        sdp: "",
        recv: 0,
        medias,
      },
    ],
    consumers: [],
  };
}

beforeEach(() => {
  vi.stubGlobal("RTCRtpReceiver", {
    getCapabilities: () => ({
      codecs: [{ mimeType: "video/H264" }, { mimeType: "video/rtx" }],
    }),
  });
});
afterEach(() => vi.unstubAllGlobals());

function evaluate(medias: string[]) {
  return evaluateStreamWebRTCAvailability({
    globallyAvailable: true,
    globalReason: null,
    metadata: metadata(medias),
  });
}

describe("WebRTC stream eligibility", () => {
  it("keeps a pending global check distinct from an unsupported stream", () => {
    expect(
      evaluateStreamWebRTCAvailability({
        globallyAvailable: false,
        globalReason: "checking",
        metadata: undefined,
      }),
    ).toEqual({ available: false, reason: "checking" });
  });
  it("allows unknown metadata and video without playback audio", () => {
    expect(evaluate([])).toEqual({ available: true });
    expect(
      evaluate(["video, recvonly, H264", "audio, sendonly, AAC/16000"]),
    ).toEqual({ available: true });
  });
  it("accepts a supported transcode when the original codec is unsupported", () => {
    expect(evaluate(["video, recvonly, H265", "video, recvonly, AVC"])).toEqual(
      { available: true },
    );
  });
  it("rejects unsupported video and playback audio with distinct reasons", () => {
    expect(evaluate(["video, recvonly, HEVC"])).toMatchObject({
      available: false,
      reason: "video-codec",
    });
    expect(
      evaluate(["video, recvonly, H264", "audio, recvonly, AAC/48000/2"]),
    ).toMatchObject({ available: false, reason: "audio-codec" });
  });
  it("accepts Opus playback alongside AAC and excludes transport codecs", () => {
    expect(
      evaluate([
        "video, recvonly, H264",
        "audio, recvonly, AAC/48000/2, OPUS/48000/2",
      ]),
    ).toEqual({ available: true });
    expect(browserWebRTCVideoCodecs()).toEqual(["H264"]);
  });
  it("uses configured TURN settings and retains the existing STUN default", () => {
    const configured = [
      {
        urls: ["turn:relay.invalid"],
        username: "test-user",
        credential: "fixture-only",
      },
    ];
    expect(webRTCIceServers(configured)).toEqual(configured);
    expect(webRTCIceServers([])).toEqual([
      { urls: "stun:stun.l.google.com:19302" },
    ]);
  });
});

it("ignores malformed signaling data and accepts typed messages", () => {
  for (const value of [
    null,
    123,
    "invalid",
    "null",
    "{}",
    '{"type":"error","value":123}',
  ]) {
    expect(parseWebRTCMessage(value)).toBeNull();
  }
  expect(parseWebRTCMessage('{"type":"webrtc/answer","value":"sdp"}')).toEqual({
    type: "webrtc/answer",
    value: "sdp",
  });
});
