/**
 * go2rtc's stream list for GET /api/go2rtc/streams (upstream), as the live
 * telemetry cards (UI146) read it: who is reading each stream.
 *
 * The consumers look like what go2rtc 1.9 lists: Frigate's own detect and
 * record ffmpeg read the restream over RTSP from 127.0.0.1, browsers come in
 * through nginx (also 127.0.0.1, but over MSE or WebRTC), and an RTSP client
 * such as Home Assistant comes from another machine.
 */

export type ViewerKind = "webrtc" | "mse" | "hls" | "mjpeg" | "rtsp";

export interface Go2rtcConsumerMock {
  id: number;
  format_name: string;
  protocol: string;
  remote_addr: string;
  user_agent: string;
}

export interface Go2rtcStreamEntryMock {
  producers: { url: string }[];
  /** go2rtc writes null, not [], for a stream nobody reads. */
  consumers: Go2rtcConsumerMock[] | null;
}

/** A player on a given client, to put one browser on several streams. */
export interface ViewerOn {
  kind: ViewerKind;
  /** The client's address; each plain kind gets an address of its own. */
  client: string;
}

/** How many of Frigate's readers and which viewers a stream has. */
export interface Go2rtcStreamReaders {
  internal?: number;
  viewers?: (ViewerKind | ViewerOn)[];
}

const BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

let nextId = 1;

/** One of Frigate's own detect, record or audio ffmpeg readers. */
export function frigateReader(): Go2rtcConsumerMock {
  const id = nextId++;
  return {
    id,
    format_name: "rtsp",
    protocol: "rtsp+tcp",
    remote_addr: `127.0.0.1:${41000 + id}`,
    user_agent: "FFmpeg Frigate/0.17.0",
  };
}

/**
 * Someone watching, the way go2rtc records each kind of player. Browsers
 * reach go2rtc through nginx, which forwards their address; WebRTC media and
 * RTSP clients connect directly.
 */
export function viewer(reader: ViewerKind | ViewerOn): Go2rtcConsumerMock {
  const id = nextId++;
  const { kind, client } =
    typeof reader === "string" ? { kind: reader, client: undefined } : reader;
  switch (kind) {
    case "webrtc":
      return {
        id,
        format_name: "webrtc/json",
        protocol: "ws",
        remote_addr: `${client ?? `192.168.1.${40 + (id % 20)}`}:${50000 + id} host`,
        user_agent: BROWSER,
      };
    case "mse":
      return {
        id,
        format_name: "mse/fmp4",
        protocol: "ws",
        remote_addr: `127.0.0.1:${52000 + id} forwarded ${client ?? `192.168.1.${60 + (id % 20)}`}`,
        user_agent: BROWSER,
      };
    case "hls":
      return {
        id,
        format_name: "hls/fmp4",
        protocol: "http",
        remote_addr: `127.0.0.1:${53000 + id} forwarded ${client ?? "192.168.1.80"}`,
        user_agent: BROWSER,
      };
    case "mjpeg":
      return {
        id,
        format_name: "mjpeg",
        protocol: "http",
        remote_addr: `127.0.0.1:${54000 + id} forwarded ${client ?? "192.168.1.81"}`,
        user_agent: BROWSER,
      };
    case "rtsp":
      return {
        id,
        format_name: "rtsp",
        protocol: "rtsp+tcp",
        remote_addr: `${client ?? "192.168.1.10"}:${40000 + id}`,
        user_agent: "Lavf60.16.100",
      };
  }
}

/**
 * The response for a set of streams.
 *
 * Args:
 *     streams: Stream name to its readers.
 */
export function go2rtcStreamsFactory(
  streams: Record<string, Go2rtcStreamReaders>,
): Record<string, Go2rtcStreamEntryMock> {
  return Object.fromEntries(
    Object.entries(streams).map(([name, readers]) => {
      const consumers = [
        ...Array.from({ length: readers.internal ?? 0 }, frigateReader),
        ...(readers.viewers ?? []).map((reader) => viewer(reader)),
      ];
      return [
        name,
        {
          producers: [{ url: "rtsp://10.0.0.5:554/stream1" }],
          consumers: consumers.length > 0 ? consumers : null,
        },
      ];
    }),
  );
}
