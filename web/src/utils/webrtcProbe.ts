import { parseWebRTCMessage } from "./webrtcUtil";
import { baseUrl } from "@/api/baseUrl";

/**
 * Performs a real WebRTC handshake against go2rtc to verify that a media
 * connection can actually be established (validates candidates, port 8555
 * reachability, and STUN/TURN end-to-end). A success is cached for the page
 * session; a failure only for PROBE_FAILURE_TTL_MS, so a slow or offline
 * moment does not disable WebRTC until reload.
 */

export type WebRTCProbeResult = {
  ok: boolean;
  detail?: string;
  /** go2rtc refused this stream (offline source), not the connection. */
  streamError?: boolean;
};

/** How long a failed probe is reused before the next caller re-probes. */
export const PROBE_FAILURE_TTL_MS = 30_000;

/** Streams tried per probe when go2rtc reports the earlier ones unavailable. */
const MAX_PROBE_STREAMS = 3;

let cachedProbe: {
  promise: Promise<WebRTCProbeResult>;
  failedAt: number | null;
} | null = null;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runProbe(
  testStream: string,
  iceServers: RTCIceServer[],
  timeoutMs: number,
): Promise<WebRTCProbeResult> {
  return new Promise<WebRTCProbeResult>((resolve) => {
    let settled = false;
    const wsURL = `${baseUrl.replace(/^http/, "ws")}live/webrtc/api/ws?src=${testStream}`;

    const pc = new RTCPeerConnection({
      bundlePolicy: "max-bundle",
      iceServers,
    });
    let ws: WebSocket | null = null;

    const cleanup = (result: WebRTCProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
      try {
        pc.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const fail = (detail: string) => cleanup({ ok: false, detail });

    const timer = setTimeout(
      () => fail(`no ICE connection within ${timeoutMs}ms`),
      timeoutMs,
    );

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === "connected" || state === "completed") {
        cleanup({ ok: true });
      } else if (state === "failed" || state === "closed") {
        fail(`ICE connection state: ${state}`);
      }
    };

    // Offer both kinds so an audio-only stream can still answer.
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    try {
      ws = new WebSocket(wsURL);
    } catch (err) {
      fail(`WebSocket to go2rtc could not be opened: ${describeError(err)}`);
      return;
    }

    ws.addEventListener("error", () => fail("WebSocket to go2rtc errored"));

    ws.addEventListener("open", () => {
      pc.addEventListener("icecandidate", (ev) => {
        if (!ev.candidate || !ws) return;
        ws.send(
          JSON.stringify({
            type: "webrtc/candidate",
            value: ev.candidate.candidate,
          }),
        );
      });

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          ws?.send(
            JSON.stringify({
              type: "webrtc/offer",
              value: pc.localDescription?.sdp,
            }),
          );
        })
        .catch((err) =>
          fail(`failed to create the local offer: ${describeError(err)}`),
        );
    });

    ws.addEventListener("message", (ev) => {
      const msg = parseWebRTCMessage((ev as MessageEvent<unknown>).data);
      if (!msg) return;
      if (msg.type === "webrtc/candidate") {
        pc.addIceCandidate({ candidate: msg.value, sdpMid: "0" }).catch((err) =>
          fail(`remote ICE candidate rejected: ${describeError(err)}`),
        );
      } else if (msg.type === "webrtc/answer") {
        pc.setRemoteDescription({ type: "answer", sdp: msg.value }).catch(
          (err) => fail(`remote answer rejected: ${describeError(err)}`),
        );
      } else if (msg.type === "error") {
        // go2rtc could not open the stream's source, which says nothing
        // about whether WebRTC itself can connect.
        cleanup({
          ok: false,
          streamError: true,
          detail: `go2rtc stream ${testStream} unavailable: ${msg.value}`,
        });
      }
    });
  });
}

/** Moves to the next stream only when go2rtc refused the current one. */
async function runProbes(
  testStreams: string[],
  iceServers: RTCIceServer[],
  timeoutMs: number,
): Promise<WebRTCProbeResult> {
  let result: WebRTCProbeResult = {
    ok: false,
    detail: "no go2rtc stream to probe",
  };
  for (const stream of testStreams.slice(0, MAX_PROBE_STREAMS)) {
    result = await runProbe(stream, iceServers, timeoutMs);
    if (!result.streamError) {
      return result;
    }
  }
  return result;
}

/**
 * Probes the given streams in order (put the one being viewed first). Every
 * caller shares one probe while it runs.
 */
export function probeWebRTCAvailability(
  testStreams: string[],
  iceServers: RTCIceServer[],
  timeoutMs: number = 5000,
): Promise<WebRTCProbeResult> {
  if (
    cachedProbe &&
    (cachedProbe.failedAt === null ||
      Date.now() - cachedProbe.failedAt < PROBE_FAILURE_TTL_MS)
  ) {
    return cachedProbe.promise;
  }
  const entry: NonNullable<typeof cachedProbe> = {
    promise: runProbes(testStreams, iceServers, timeoutMs).then(
      (result) => {
        if (!result.ok) entry.failedAt = Date.now();
        return result;
      },
      (err: unknown) => {
        // e.g. RTCPeerConnection throwing: expire it like any other failure.
        entry.failedAt = Date.now();
        return { ok: false, detail: describeError(err) };
      },
    ),
    failedAt: null,
  };
  cachedProbe = entry;
  return entry.promise;
}

/** Clears the cached probe result (e.g. when go2rtc config changes). */
export function resetWebRTCProbe(): void {
  cachedProbe = null;
}
