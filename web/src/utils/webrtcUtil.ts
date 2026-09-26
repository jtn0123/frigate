import { FrigateConfig } from "@/types/frigateConfig";

/**
 * Helpers for detecting what the current browser can do over WebRTC.
 * Used to gate the WebRTC live streaming option (e.g. H.265 is only
 * decodable over WebRTC on Chrome 136+ / Safari 18+ with HEVC hardware).
 */

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

type ConfiguredIceServers = NonNullable<
  FrigateConfig["go2rtc"]["webrtc"]
>["ice_servers"];

/** ICE servers for browser peer connections, falling back to public STUN. */
export function webRTCIceServers(
  configured: ConfiguredIceServers,
): RTCIceServer[] {
  if (!configured?.length) {
    return DEFAULT_ICE_SERVERS;
  }

  return configured.map((server) => ({
    urls: server.urls,
    username: server.username,
    credential: server.credential,
  }));
}

export function browserSupportsWebRTC(): boolean {
  return typeof window !== "undefined" && "RTCPeerConnection" in window;
}

/** Codec aliases that refer to the same underlying codec. */
const CODEC_ALIASES: Record<string, string> = {
  HEVC: "H265",
  AVC: "H264",
};

function normalizeCodec(codec: string): string {
  const upper = codec.toUpperCase();
  return CODEC_ALIASES[upper] ?? upper;
}

/** The set of video codec names the browser can receive over WebRTC. */
export function browserWebRTCVideoCodecs(): string[] {
  if (
    typeof RTCRtpReceiver === "undefined" ||
    typeof RTCRtpReceiver.getCapabilities !== "function"
  ) {
    return [];
  }

  const caps = RTCRtpReceiver.getCapabilities("video");
  if (!caps) return [];

  const codecs = new Set<string>();
  for (const codec of caps.codecs) {
    // mimeType is like "video/H264"; ignore infra codecs (rtx, red, ulpfec)
    const name = codec.mimeType.split("/")[1]?.toUpperCase();
    if (!name || ["RTX", "RED", "ULPFEC", "FLEXFEC-03"].includes(name)) {
      continue;
    }
    codecs.add(normalizeCodec(name));
  }
  return Array.from(codecs);
}

export function browserSupportsWebRTCVideoCodec(codec: string): boolean {
  return browserWebRTCVideoCodecs().includes(normalizeCodec(codec));
}

/** Accept only the text signaling messages understood by the player. */
export function parseWebRTCMessage(
  data: unknown,
): { type: string; value: string } | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    !("value" in parsed) ||
    typeof parsed.type !== "string" ||
    typeof parsed.value !== "string"
  )
    return null;
  return { type: parsed.type, value: parsed.value };
}
