import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserSupportsWebRTC,
  browserSupportsWebRTCVideoCodec,
  browserWebRTCVideoCodecs,
  parseWebRTCMessage,
  webRTCIceServers,
} from "@/utils/webrtcUtil";

function stubCapabilities(caps: RTCRtpCapabilities | null) {
  vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => caps });
}

function codecs(...mimeTypes: string[]): RTCRtpCapabilities {
  return {
    codecs: mimeTypes.map((mimeType) => ({ mimeType, clockRate: 90000 })),
    headerExtensions: [],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("webRTCIceServers", () => {
  it("falls back to public STUN when nothing is configured", () => {
    expect(webRTCIceServers(undefined)).toEqual([
      { urls: "stun:stun.l.google.com:19302" },
    ]);
  });

  it("copies only the fields a peer connection understands", () => {
    const server = { urls: "stun:stun.invalid", extra: "ignored" };
    expect(webRTCIceServers([server])).toEqual([
      { urls: "stun:stun.invalid", username: undefined, credential: undefined },
    ]);
  });
});

describe("browserSupportsWebRTC", () => {
  it("reports support only when RTCPeerConnection exists", () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    Reflect.deleteProperty(window, "RTCPeerConnection");
    expect(browserSupportsWebRTC()).toBe(false);
    vi.stubGlobal("RTCPeerConnection", class {});
    expect(browserSupportsWebRTC()).toBe(true);
  });

  it("reports no support outside a browser window", () => {
    vi.stubGlobal("window", undefined);
    expect(browserSupportsWebRTC()).toBe(false);
  });
});

describe("browserWebRTCVideoCodecs", () => {
  it("returns nothing when the receiver API is missing", () => {
    vi.stubGlobal("RTCRtpReceiver", undefined);
    expect(browserWebRTCVideoCodecs()).toEqual([]);
  });

  it("returns nothing when getCapabilities is not a function", () => {
    vi.stubGlobal("RTCRtpReceiver", { getCapabilities: "nope" });
    expect(browserWebRTCVideoCodecs()).toEqual([]);
  });

  it("returns nothing when the browser reports no video capabilities", () => {
    stubCapabilities(null);
    expect(browserWebRTCVideoCodecs()).toEqual([]);
  });

  it("normalizes aliases, dedupes and skips transport and malformed codecs", () => {
    stubCapabilities(
      codecs(
        "video/hevc",
        "video/H265",
        "video/avc",
        "video/VP9",
        "video/rtx",
        "video/red",
        "video/ulpfec",
        "video/flexfec-03",
        "video",
        "video/",
      ),
    );
    expect(browserWebRTCVideoCodecs()).toEqual(["H265", "H264", "VP9"]);
  });
});

describe("browserSupportsWebRTCVideoCodec", () => {
  it("matches codec names through their aliases", () => {
    stubCapabilities(codecs("video/H265"));
    expect(browserSupportsWebRTCVideoCodec("hevc")).toBe(true);
    expect(browserSupportsWebRTCVideoCodec("H265")).toBe(true);
    expect(browserSupportsWebRTCVideoCodec("avc")).toBe(false);
  });
});

describe("parseWebRTCMessage", () => {
  it("rejects values whose type or value field is missing or not a string", () => {
    for (const value of [
      42,
      "not json",
      "null",
      '"text"',
      "[]",
      '{"value":"sdp"}',
      '{"type":"webrtc/answer"}',
      '{"type":1,"value":"sdp"}',
    ]) {
      expect(parseWebRTCMessage(value)).toBeNull();
    }
  });

  it("drops extra fields from an accepted message", () => {
    expect(
      parseWebRTCMessage('{"type":"webrtc/candidate","value":"c","x":1}'),
    ).toEqual({ type: "webrtc/candidate", value: "c" });
  });
});
