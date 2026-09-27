import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { FrigateConfig } from "@/types/frigateConfig";
import { LiveStreamMetadata, WebRTCUnavailableReason } from "@/types/live";
import {
  browserSupportsWebRTC,
  browserSupportsWebRTCVideoCodec,
  browserWebRTCVideoCodecs,
  webRTCIceServers,
} from "@/utils/webrtcUtil";
import {
  getPlaybackAudioCodecs,
  getStreamVideoCodecs,
} from "@/utils/cameraUtil";
import { probeWebRTCAvailability, resetWebRTCProbe } from "@/utils/webrtcProbe";

const WEBRTC_AUDIO_CODECS = new Set(["OPUS", "PCMA", "PCMU"]);

type GlobalAvailability = {
  globallyAvailable: boolean;
  globalReason: WebRTCUnavailableReason | null;
};

export type StreamAvailability = {
  available: boolean;
  reason?: WebRTCUnavailableReason;
  detail?: string;
};

/** Split out of the hook so the decision can be exercised without React. */
export function evaluateStreamWebRTCAvailability(args: {
  globallyAvailable: boolean;
  globalReason: WebRTCUnavailableReason | null;
  metadata: LiveStreamMetadata | null | undefined;
}): StreamAvailability {
  const { globallyAvailable, globalReason, metadata } = args;

  if (!globallyAvailable) {
    return { available: false, reason: globalReason ?? "unreachable" };
  }

  // The metadata endpoint enumerates every producer variant including `#video=`
  // transcodes, so an empty list means unknown rather than unplayable.
  const videoCodecs = getStreamVideoCodecs(metadata);
  if (
    videoCodecs.length > 0 &&
    !videoCodecs.some((c) => browserSupportsWebRTCVideoCodec(c))
  ) {
    const browserCodecs = browserWebRTCVideoCodecs();
    return {
      available: false,
      reason: "video-codec",
      detail:
        `Stream video codecs [${videoCodecs.join(", ")}] cannot be received over WebRTC in this browser ` +
        `(browser supports: ${browserCodecs.length ? browserCodecs.join(", ") : "none"}).`,
    };
  }

  // A stream with no playback audio is not disqualified.
  const playbackAudioCodecs = getPlaybackAudioCodecs(metadata);
  if (
    playbackAudioCodecs.length > 0 &&
    !playbackAudioCodecs.some((c) => WEBRTC_AUDIO_CODECS.has(c))
  ) {
    return {
      available: false,
      reason: "audio-codec",
      detail:
        `Stream playback audio codecs [${playbackAudioCodecs.join(", ")}] cannot be carried over WebRTC ` +
        `(supported: ${Array.from(WEBRTC_AUDIO_CODECS).join(", ")}).`,
    };
  }

  return { available: true };
}

export type WebRTCTalkState = "available" | "pending" | "unavailable";

/**
 * Two-way talk needs a WebRTC connection for the stream, but not one that can
 * carry its playback audio: the backchannel is sent, not received.
 */
export function webRTCTalkState(stream: StreamAvailability): WebRTCTalkState {
  if (stream.available || stream.reason === "audio-codec") {
    return "available";
  }
  return stream.reason === "checking" ? "pending" : "unavailable";
}

/**
 * Mirrors docker/main/rootfs/usr/local/go2rtc/create_config.py, which adds
 * default candidates unless the user set `candidates` explicitly (even to an
 * empty list).
 */
export function isWebRTCConfigured(
  webrtc: FrigateConfig["go2rtc"]["webrtc"],
): boolean {
  if (webrtc?.candidates == null) {
    return true;
  }
  return webrtc.candidates.length > 0 || (webrtc.ice_servers?.length ?? 0) > 0;
}

/** Streams to probe, the one being viewed first. */
export function webRTCProbeStreams(
  streams: Record<string, unknown> | undefined,
  preferredStream?: string,
): string[] {
  const names = Object.keys(streams ?? {});
  if (!preferredStream || !names.includes(preferredStream)) {
    return names;
  }
  return [preferredStream, ...names.filter((name) => name !== preferredStream)];
}

/** go2rtc config the cached probe result belongs to. */
let lastProbeSignature: string | null = null;

/**
 * Browser support, go2rtc config, and a live handshake probe shared by the
 * page. A failed probe is retried on a later mount or when the page becomes
 * visible again once its cached result has expired.
 */
export function useWebRTCGloballyAvailable(
  preferredStream?: string,
): GlobalAvailability {
  const { data: config } = useSWR<FrigateConfig>("config");
  const [probe, setProbe] = useState<{
    state: "pending" | "pass" | "fail";
    detail?: string;
  }>({ state: "pending" });

  const browserOk = browserSupportsWebRTC();

  const configured = useMemo(
    () => config !== undefined && isWebRTCConfigured(config.go2rtc.webrtc),
    [config],
  );

  const testStreams = useMemo(
    () => webRTCProbeStreams(config?.go2rtc.streams, preferredStream),
    [config, preferredStream],
  );
  const testStreamsKey = testStreams.join("\n");

  const [retryToken, setRetryToken] = useState(0);

  const iceServers = useMemo(
    () => webRTCIceServers(config?.go2rtc.webrtc?.ice_servers),
    [config],
  );

  // Identity of the cached page-session probe: a config change here must
  // re-probe rather than return a stale result.
  const probeSignature = useMemo(
    () =>
      JSON.stringify({
        candidates: config?.go2rtc.webrtc?.candidates ?? [],
        iceServers,
        streams: Object.keys(config?.go2rtc.streams ?? {}),
      }),
    [config, iceServers],
  );

  useEffect(() => {
    // Runs on every consumer's mount, but the probe cache is page-wide:
    // clearing them unconditionally would re-probe once per consumer.
    if (lastProbeSignature !== probeSignature) {
      lastProbeSignature = probeSignature;
      resetWebRTCProbe();
    }
    setProbe({ state: "pending" });
  }, [probeSignature]);

  useEffect(() => {
    if (probe.state !== "fail") {
      return;
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        setRetryToken((token) => token + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [probe.state]);

  useEffect(() => {
    const streams = testStreamsKey ? testStreamsKey.split("\n") : [];
    if (!browserOk || !configured || streams.length === 0) {
      return;
    }
    let cancelled = false;
    void probeWebRTCAvailability(streams, iceServers).then(
      (result) => {
        if (!cancelled) {
          setProbe({
            state: result.ok ? "pass" : "fail",
            detail: result.detail,
          });
        }
      },
      () => {
        if (!cancelled) setProbe({ state: "fail" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [browserOk, configured, testStreamsKey, iceServers, retryToken]);

  const availability = useMemo<GlobalAvailability>(() => {
    if (!browserOk) {
      return { globallyAvailable: false, globalReason: "browser" };
    }
    if (!configured) {
      return { globallyAvailable: false, globalReason: "not-configured" };
    }
    if (probe.state === "pending") {
      return { globallyAvailable: false, globalReason: "checking" };
    }
    if (probe.state === "fail") {
      return { globallyAvailable: false, globalReason: "unreachable" };
    }
    return { globallyAvailable: true, globalReason: null };
  }, [browserOk, configured, probe]);

  return availability;
}

/** Per-stream WebRTC availability for selectors and auto-selection. */
export function useWebRTCAvailableForStream(
  metadata: LiveStreamMetadata | null | undefined,
  streamName?: string,
): StreamAvailability {
  const { globallyAvailable, globalReason } =
    useWebRTCGloballyAvailable(streamName);

  const availability = useMemo(
    () =>
      evaluateStreamWebRTCAvailability({
        globallyAvailable,
        globalReason,
        metadata,
      }),
    [globallyAvailable, globalReason, metadata],
  );

  return availability;
}
