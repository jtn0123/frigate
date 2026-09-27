import { baseUrl } from "@/api/baseUrl";
import {
  LivePlayerError,
  PlayerStatsType,
  TwoWayTalkError,
} from "@/types/live";
import { FrigateConfig } from "@/types/frigateConfig";
import { parseWebRTCMessage, webRTCIceServers } from "@/utils/webrtcUtil";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { wrapAsync } from "@/utils/promise";
import { closePeerConnection } from "@/lib/fork/peer-connection";
import useSWR from "swr";

type WebRtcPlayerProps = {
  className?: string;
  camera: string;
  playbackEnabled?: boolean;
  audioEnabled?: boolean;
  volume?: number;
  microphoneEnabled?: boolean;
  iOSCompatFullScreen?: boolean; // ios doesn't support fullscreen divs so we must support the video element
  pip?: boolean;
  getStats?: boolean;
  setStats?: (stats: PlayerStatsType) => void;
  onPlaying?: () => void;
  onError?: (error: LivePlayerError) => void;
  onMicrophoneError?: (error: TwoWayTalkError) => void;
};

export default function WebRtcPlayer({
  className,
  camera,
  playbackEnabled = true,
  audioEnabled = false,
  volume,
  microphoneEnabled = false,
  iOSCompatFullScreen = false,
  pip = false,
  getStats = false,
  setStats,
  onPlaying,
  onError,
  onMicrophoneError,
}: Readonly<WebRtcPlayerProps>) {
  // metadata

  const { data: config } = useSWR<FrigateConfig>("config");

  // Keyed on the serialized list so an unrelated config update doesn't
  // reconnect every WebRTC player.
  const iceServersKey = JSON.stringify(
    config?.go2rtc.webrtc?.ice_servers ?? [],
  );
  const iceServers = useMemo(
    () =>
      webRTCIceServers(
        JSON.parse(iceServersKey) as Parameters<typeof webRTCIceServers>[0],
      ),
    [iceServersKey],
  );

  const wsURL = useMemo(() => {
    return `${baseUrl.replace(/^http/, "ws")}live/webrtc/api/ws?src=${camera}`;
  }, [camera]);

  // error handler
  const handleError = useCallback(
    (error: LivePlayerError, description: string = "Unknown error") => {
      // eslint-disable-next-line no-console
      console.error(
        `${camera} - WebRTC error '${error}': ${description} See the documentation: https://docs.frigate.video/configuration/live/#live-player-error-messages`,
      );
      onError?.(error);
    },
    [camera, onError],
  );

  // camera states

  const pcRef = useRef<RTCPeerConnection | undefined>(undefined);
  const wsRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Separate sendonly-audio connection for two-way talk: go2rtc only wires the
  // backchannel from a connection's initial offer.
  const micPcRef = useRef<RTCPeerConnection | undefined>(undefined);
  const micWsRef = useRef<WebSocket | null>(null);
  const [bufferTimeout, setBufferTimeout] = useState<NodeJS.Timeout>();
  const videoLoadTimeoutRef = useRef<NodeJS.Timeout>(undefined);

  const PeerConnection = useCallback(
    async (media: string, cancelled: () => boolean) => {
      if (!videoRef.current) {
        return;
      }

      const pc = new RTCPeerConnection({
        bundlePolicy: "max-bundle",
        iceServers,
      });

      const localTracks = [];

      if (/camera|microphone/.test(media)) {
        const tracks = await getMediaTracks("user", {
          video: media.indexOf("camera") >= 0,
          audio: media.indexOf("microphone") >= 0,
        });
        tracks.forEach((track) => {
          pc.addTransceiver(track, { direction: "sendonly" });
          if (track.kind === "video") localTracks.push(track);
        });
      }

      if (media.indexOf("display") >= 0) {
        const tracks = await getMediaTracks("display", {
          video: true,
          audio: media.indexOf("speaker") >= 0,
        });
        tracks.forEach((track) => {
          pc.addTransceiver(track, { direction: "sendonly" });
          if (track.kind === "video") localTracks.push(track);
        });
      }

      if (/video|audio/.test(media)) {
        const tracks = ["video", "audio"]
          .filter((kind) => media.indexOf(kind) >= 0)
          .map(
            (kind) =>
              pc.addTransceiver(kind, { direction: "recvonly" }).receiver.track,
          );
        localTracks.push(...tracks);
      }

      // fork (UI71): the effect was cleaned up while the mic prompt was open
      if (cancelled()) {
        closePeerConnection(pc);
        return;
      }

      videoRef.current.srcObject = new MediaStream(localTracks);
      return pc;
    },
    [videoRef, iceServers],
  );

  async function getMediaTracks(
    media: string,
    constraints: MediaStreamConstraints,
  ) {
    try {
      const stream =
        media === "user"
          ? await navigator.mediaDevices.getUserMedia(constraints)
          : await navigator.mediaDevices.getDisplayMedia(constraints);
      return stream.getTracks();
    } catch (e) {
      return [];
    }
  }

  // Offer/answer/ICE exchange over the WebSocket; shared by both connections.
  const startSignaling = useCallback((pc: RTCPeerConnection, ws: WebSocket) => {
    ws.addEventListener("open", () => {
      pc.addEventListener("icecandidate", (ev) => {
        if (!ev.candidate) return;
        ws.send(
          JSON.stringify({
            type: "webrtc/candidate",
            value: ev.candidate.candidate,
          }),
        );
      });

      void pc
        .createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          ws.send(
            JSON.stringify({
              type: "webrtc/offer",
              value: pc.localDescription?.sdp,
            }),
          );
        });
    });

    ws.addEventListener("message", (ev) => {
      const msg = parseWebRTCMessage(ev.data);
      if (!msg) return;
      if (msg.type === "webrtc/candidate") {
        void pc.addIceCandidate({ candidate: msg.value, sdpMid: "0" });
      } else if (msg.type === "webrtc/answer") {
        void pc.setRemoteDescription({ type: "answer", sdp: msg.value });
      }
    });
  }, []);

  const connect = useCallback(
    async (
      aPc: Promise<RTCPeerConnection | undefined>,
      cancelled: () => boolean,
    ) => {
      const pc = await aPc;
      if (!pc) {
        return;
      }
      if (cancelled()) {
        closePeerConnection(pc);
        return;
      }

      pcRef.current = pc;
      wsRef.current = new WebSocket(wsURL);
      startSignaling(pc, wsRef.current);
    },
    [wsURL, startSignaling],
  );

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }

    if (!playbackEnabled) {
      return;
    }

    // fork (UI71): a connection still waiting on the mic prompt when this
    // effect is cleaned up must not open a socket nobody closes
    let cancelled = false;
    const isCancelled = () => cancelled;
    const aPc = PeerConnection("video+audio", isCancelled);
    void connect(aPc, isCancelled);

    return () => {
      cancelled = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (pcRef.current) {
        // fork (UI70): also stop the microphone, which close() leaves captured
        closePeerConnection(pcRef.current);
        pcRef.current = undefined;
      }
    };
  }, [camera, connect, PeerConnection, pcRef, videoRef, playbackEnabled]);

  // Backchannel connection, alive only while the mic is on.
  useEffect(() => {
    if (!microphoneEnabled || !playbackEnabled) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const tracks = await getMediaTracks("user", {
        video: false,
        audio: true,
      });

      if (cancelled) {
        tracks.forEach((track) => track.stop());
        return;
      }

      if (tracks.length === 0) {
        onMicrophoneError?.("microphone");
        return;
      }

      const pc = new RTCPeerConnection({
        bundlePolicy: "max-bundle",
        iceServers,
      });
      tracks.forEach((track) =>
        pc.addTransceiver(track, { direction: "sendonly" }),
      );

      micPcRef.current = pc;
      const ws = new WebSocket(wsURL);
      micWsRef.current = ws;
      startSignaling(pc, ws);

      // go2rtc sends an error instead of an answer when it can't attach the
      // microphone to the camera's backchannel.
      ws.addEventListener("message", (ev) => {
        const msg = parseWebRTCMessage(ev.data);
        if (!msg) return;
        if (msg.type !== "error" || cancelled) {
          return;
        }
        onMicrophoneError?.("refused");
      });
    })();

    return () => {
      cancelled = true;
      micPcRef.current?.getSenders().forEach((sender) => sender.track?.stop());
      if (micWsRef.current) {
        micWsRef.current.close();
        micWsRef.current = null;
      }
      if (micPcRef.current) {
        micPcRef.current.close();
        micPcRef.current = undefined;
      }
    };
  }, [
    microphoneEnabled,
    playbackEnabled,
    wsURL,
    startSignaling,
    iceServers,
    camera,
    onMicrophoneError,
  ]);

  // ios compat

  const [iOSCompatControls, setiOSCompatControls] = useState(false);

  // control pip

  useEffect(() => {
    if (!videoRef.current || !pip) {
      return;
    }

    void videoRef.current.requestPictureInPicture();
  }, [pip, videoRef]);

  // control volume

  useEffect(() => {
    if (!videoRef.current || volume == undefined) {
      return;
    }

    videoRef.current.volume = volume;
  }, [volume, videoRef]);

  useEffect(() => {
    // fork (UI72): an idle tile mounts with playback off; only time a
    // connection that is actually being made
    if (!playbackEnabled) {
      return;
    }

    videoLoadTimeoutRef.current = setTimeout(() => {
      handleError("stalled", "WebRTC connection timed out.");
    }, 5000);

    return () => {
      if (videoLoadTimeoutRef.current) {
        clearTimeout(videoLoadTimeoutRef.current);
      }
    };
    // we know that these deps are correct
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackEnabled]);

  const handleLoadedData = () => {
    if (videoLoadTimeoutRef.current) {
      clearTimeout(videoLoadTimeoutRef.current);
    }
    onPlaying?.();
  };

  // stats

  useEffect(() => {
    if (!pcRef.current || !getStats) return;

    let lastBytesReceived = 0;
    let lastTimestamp = 0;

    const interval = setInterval(
      wrapAsync(async () => {
        if (pcRef.current && videoRef.current && !videoRef.current.paused) {
          const report = await pcRef.current.getStats();
          let bytesReceived = 0;
          let timestamp = 0;
          let roundTripTime = 0;
          let framesReceived = 0;
          let framesDropped = 0;
          let framesDecoded = 0;

          report.forEach((stat) => {
            if (stat.type === "inbound-rtp" && stat.kind === "video") {
              bytesReceived = stat.bytesReceived;
              timestamp = stat.timestamp;
              framesReceived = stat.framesReceived;
              framesDropped = stat.framesDropped;
              framesDecoded = stat.framesDecoded;
            }
            if (stat.type === "candidate-pair" && stat.state === "succeeded") {
              roundTripTime = stat.currentRoundTripTime;
            }
          });

          const timeDiff = (timestamp - lastTimestamp) / 1000; // in seconds
          const bitrate =
            timeDiff > 0
              ? (bytesReceived - lastBytesReceived) / timeDiff / 1000
              : 0; // in kBps

          setStats?.({
            streamType: "WebRTC",
            bandwidth: Math.round(bitrate),
            latency: roundTripTime,
            totalFrames: framesReceived,
            droppedFrames: framesDropped,
            decodedFrames: framesDecoded,
            droppedFrameRate:
              framesReceived > 0 ? (framesDropped / framesReceived) * 100 : 0,
          });

          lastBytesReceived = bytesReceived;
          lastTimestamp = timestamp;
        }
      }),
      1000,
    );

    return () => {
      clearInterval(interval);
      setStats?.({
        streamType: "-",
        bandwidth: 0,
        totalFrames: 0,
        droppedFrames: undefined,
        decodedFrames: 0,
        droppedFrameRate: 0,
      });
    };
    // we need to listen on the value of the ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pcRef, pcRef.current, getStats]);

  return (
    // Camera media has no caption track supplied by the recording or stream.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      ref={videoRef}
      className={className}
      controls={iOSCompatControls}
      autoPlay
      playsInline
      muted={!audioEnabled}
      onLoadedData={handleLoadedData}
      onProgress={
        onError != undefined
          ? () => {
              if (videoRef.current?.paused) {
                return;
              }

              if (bufferTimeout) {
                clearTimeout(bufferTimeout);
                setBufferTimeout(undefined);
              }

              setBufferTimeout(
                setTimeout(() => {
                  if (
                    document.visibilityState === "visible" &&
                    pcRef.current != undefined
                  ) {
                    handleError(
                      "stalled",
                      "Media playback has stalled after 3 seconds due to insufficient buffering or a network interruption.",
                    );
                  }
                }, 3000),
              );
            }
          : undefined
      }
      onClick={
        iOSCompatFullScreen
          ? () => setiOSCompatControls(!iOSCompatControls)
          : undefined
      }
      onError={(e) => {
        if (
          // @ts-expect-error code does exist
          e.target.error.code == MediaError.MEDIA_ERR_NETWORK
        ) {
          handleError("startup", "Browser reported a network error.");
        }
      }}
    />
  );
}
