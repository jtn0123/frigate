/**
 * Fork (UI146): the live telemetry cards on the System page.
 *
 * Pure helpers that turn three reads into what the cards show:
 * - `/api/fork/go2rtc_state` (I57): per camera, its go2rtc streams with the
 *   receive rate the backend measured between two reads of go2rtc.
 * - `/api/go2rtc/streams` (upstream): go2rtc's own stream list, whose
 *   consumers say who is reading each stream.
 * - `/api/stats/history`: the detectors' inference speed, 15 s apart.
 *
 * The bitrate has no history on the server, so the cards keep their own
 * short rolling window of samples for the sparklines.
 */

import type {
  Go2rtcStateResponse,
  Go2rtcStreamState,
} from "@/types/fork/go2rtcState";
import type {
  Go2rtcConsumer,
  Go2rtcStreamsResponse,
} from "@/types/fork/go2rtcStreams";
import { InferenceThreshold } from "@/types/graph";
import { isReplayCamera } from "@/utils/cameraUtil";

/** How far back the sparklines reach, in seconds. */
export const TELEMETRY_WINDOW_SECONDS = 300;

/** How a reader is attached to a stream, as the viewer breakdown names it. */
export type ConsumerKind =
  "webrtc" | "mse" | "hls" | "mjpeg" | "rtsp" | "other";

/** The order the breakdown lists the kinds in. */
export const CONSUMER_KINDS: readonly ConsumerKind[] = [
  "webrtc",
  "mse",
  "hls",
  "mjpeg",
  "rtsp",
  "other",
];

/**
 * Who a reader belongs to: its client's address and user agent, or the
 * reader itself when go2rtc lists neither, so that such a reader still
 * counts once on its own.
 */
export type ClientKey = string | Go2rtcConsumer;

export type ConsumerCounts = {
  /**
   * Distinct clients watching: one browser or app on one address. A Live
   * dashboard playing three cameras is one viewer with three streams.
   */
  viewers: number;
  /** The viewers' streams, one per player or app reading a stream. */
  streams: number;
  /** Frigate's own readers: detect, record and audio ffmpeg, go2rtc transcoders. */
  internal: number;
  /** The viewers' streams per kind; internal readers are not in here. */
  kinds: Record<ConsumerKind, number>;
  /** The viewers' keys, so that counts over several streams stay distinct. */
  clients: ReadonlySet<ClientKey>;
};

/**
 * Whether Frigate measures a camera's incoming bitrate.
 * - `measured`: go2rtc has the camera's stream and every ffmpeg input of the
 *   camera reads it from go2rtc's restream, so go2rtc sees all the traffic.
 * - `partial`: go2rtc has a stream, but Frigate also reads the camera
 *   directly; that second connection is not counted.
 * - `notMeasured`: the camera does not go through go2rtc at all.
 */
export type MeasureStatus = "measured" | "partial" | "notMeasured";

/** The part of a camera's config the table needs. */
export type TelemetryCamera = {
  name: string;
  /** ffmpeg input paths; restream inputs read `rtsp://127.0.0.1:8554/<stream>`. */
  inputs: string[];
};

export type CameraTelemetry = {
  camera: string;
  /** The camera's streams that go2rtc has. */
  streams: string[];
  status: MeasureStatus;
  /** Null when not measured, or before the backend has two samples. */
  bytesPerSecond: number | null;
  codecs: string[];
  /** Null while go2rtc's consumer list is unavailable. */
  consumers: ConsumerCounts | null;
};

export type TelemetryTotals = {
  /** Sum over every stream measured once; null before any stream has a rate. */
  bytesPerSecond: number | null;
  consumers: ConsumerCounts | null;
  measuredCameras: number;
  partialCameras: number;
  cameras: number;
};

/** One read of the go2rtc state, as the sparklines keep it. */
export type TelemetrySample = {
  /** The backend's `updated`, unix seconds. */
  t: number;
  bytesPerSecond: number | null;
  viewers: number | null;
  cameras: Record<string, number | null>;
};

export type SparkSeries = { values: number[]; times: number[] };

export type LatencyLevel = "ok" | "warning" | "error";

export type DetectorLatency = {
  name: string;
  /** Newest inference speed in milliseconds. */
  latest: number;
  level: LatencyLevel;
  series: SparkSeries;
};

const RESTREAM_INPUT =
  /^rtsps?:\/\/(?:[^@/]*@)?(?:127\.0\.0\.1|localhost|\[::1\]):8554\//i;

// Frigate's ffmpeg presets send `FFmpeg Frigate/<version>`; go2rtc's own
// ffmpeg (an `ffmpeg:<stream>#audio=opus` transcoder) sends `go2rtc/ffmpeg`.
const INTERNAL_AGENT = /^(?:ffmpeg frigate\/|go2rtc\/)/i;

/** The parts of the Frigate config the cards read. */
export type TelemetryConfig = {
  cameras: Record<
    string,
    {
      name: string;
      enabled_in_config: boolean;
      ui: { order: number };
      ffmpeg: { inputs: readonly { path: string }[] };
    }
  >;
};

/** The parts of a `/stats/history` sample the latency card reads. */
export type LatencyStatsSample = {
  service?: { last_updated?: number };
  detectors?: Record<string, { inference_speed?: number }>;
};

/** True when an ffmpeg input reads go2rtc's restream rather than the camera. */
export function isRestreamInput(path: string): boolean {
  return RESTREAM_INPUT.test(path.trim());
}

/**
 * The enabled cameras, in the order the UI lists them.
 *
 * Args:
 *     config: The Frigate config, or undefined while it loads.
 *
 * Returns:
 *     Each camera with its ffmpeg input paths; replay cameras are left out.
 */
export function telemetryCameras(
  config: TelemetryConfig | undefined,
): TelemetryCamera[] {
  return Object.values(config?.cameras ?? {})
    .filter((camera) => camera.enabled_in_config)
    .filter((camera) => !isReplayCamera(camera.name))
    .sort((a, b) => a.ui.order - b.ui.order || a.name.localeCompare(b.name))
    .map((camera) => ({
      name: camera.name,
      inputs: camera.ffmpeg.inputs.map((input) => input.path),
    }));
}

/** The kind of reader, from go2rtc 1.9's `format_name` or an older `type`. */
export function consumerKind(consumer: Go2rtcConsumer): ConsumerKind {
  const name = (
    consumer.format_name ||
    consumer.type ||
    consumer.protocol ||
    ""
  )
    .toLowerCase()
    .trim();
  if (name.includes("webrtc")) return "webrtc";
  if (name.includes("mse")) return "mse";
  if (name.includes("hls")) return "hls";
  if (name.includes("jpeg")) return "mjpeg";
  if (name.includes("rtsp")) return "rtsp";
  return "other";
}

/**
 * The host a reader connected from, without its port.
 *
 * go2rtc writes `host:port` or `[v6]:port`, and appends
 * ` forwarded <X-Forwarded-For>` for a proxied request; the first address is
 * the one that opened the connection to go2rtc.
 */
export function remoteHost(remoteAddr: string | undefined): string {
  const first = (remoteAddr ?? "").trim().split(/[\s,]+/)[0] ?? "";
  if (first.startsWith("[")) {
    const end = first.indexOf("]");
    return end > 0 ? first.slice(1, end) : first;
  }
  // a single colon separates the port; more than one is a bare IPv6 address
  const colon = first.indexOf(":");
  return colon > 0 && colon === first.lastIndexOf(":")
    ? first.slice(0, colon)
    : first;
}

function isLoopback(host: string): boolean {
  const value = host.toLowerCase();
  return (
    value === "localhost" ||
    value === "::1" ||
    /^127\./.test(value) ||
    /^::ffff:127\./.test(value)
  );
}

/**
 * The address of the client behind a reader, without its port.
 *
 * A reader that came through a proxy, such as Frigate's nginx, is listed as
 * `<proxy> forwarded <X-Forwarded-For>`, and the first forwarded address is
 * the client that made the request. Otherwise the reader's own address is
 * the client's. An IPv4 address go2rtc wrote in its IPv6 form is unwrapped,
 * so a browser's MSE and WebRTC players compare equal.
 */
export function clientAddress(remoteAddr: string | undefined): string {
  const value = (remoteAddr ?? "").trim();
  const forwarded = /\sforwarded\s+(\S.*)$/i.exec(value);
  const host = (forwarded ? remoteHost(forwarded[1]) : "") || remoteHost(value);
  return host.replace(/^::ffff:(?=\d+\.)/i, "");
}

/**
 * Who a reader belongs to, to count a person with several players once.
 *
 * A browser opens one reader per stream it plays, all from the same address
 * with the same user agent, so they share a key. Two people behind the same
 * proxy (one that does not forward their address) with the same browser
 * share it too, and count as one.
 */
export function clientKey(consumer: Go2rtcConsumer): ClientKey {
  const address = clientAddress(consumer.remote_addr);
  const agent = (consumer.user_agent ?? "").trim();
  return address || agent ? `${address}\n${agent}` : consumer;
}

/**
 * True for a reader that is Frigate itself rather than someone watching.
 *
 * Frigate's detect, record and audio ffmpeg read a restreamed camera over
 * RTSP from the same machine, and so does a go2rtc transcoder. Browsers never
 * use RTSP, and their MSE and WebRTC sessions reach go2rtc through Frigate's
 * nginx, so they also come from the loopback address: the protocol, not the
 * address alone, tells them apart. A remote RTSP reader (Home Assistant, VLC)
 * counts as a viewer, unless its user agent is Frigate's or go2rtc's own.
 */
export function isInternalConsumer(consumer: Go2rtcConsumer): boolean {
  if (INTERNAL_AGENT.test((consumer.user_agent ?? "").trim())) {
    return true;
  }
  return (
    consumerKind(consumer) === "rtsp" &&
    isLoopback(remoteHost(consumer.remote_addr))
  );
}

/**
 * True for a WebRTC reader that never connected: ICE picked no candidate
 * pair (no remote address) and go2rtc has sent it nothing.
 *
 * The Live page checks whether WebRTC works by opening a WebRTC session to
 * the stream and closing it again. When that check cannot connect (port
 * 8555 not reachable), go2rtc keeps listing the half-open reader for about
 * 30 s, next to the MSE player that is actually showing the stream. Counting
 * it would show two viewers for one open page.
 */
export function isUnconnectedConsumer(consumer: Go2rtcConsumer): boolean {
  if (consumerKind(consumer) !== "webrtc") return false;
  const sent = consumer.bytes_send ?? 0;
  return !(consumer.remote_addr ?? "").trim() && !(sent > 0);
}

function emptyKinds(): Record<ConsumerKind, number> {
  return { webrtc: 0, mse: 0, hls: 0, mjpeg: 0, rtsp: 0, other: 0 };
}

/** Count one stream's readers into viewers, their streams and Frigate's own. */
export function countConsumers(
  consumers: readonly Go2rtcConsumer[] | null | undefined,
): ConsumerCounts {
  const kinds = emptyKinds();
  const clients = new Set<ClientKey>();
  let streams = 0;
  let internal = 0;
  for (const consumer of consumers ?? []) {
    if (isUnconnectedConsumer(consumer)) {
      continue;
    }
    if (isInternalConsumer(consumer)) {
      internal += 1;
    } else {
      streams += 1;
      kinds[consumerKind(consumer)] += 1;
      clients.add(clientKey(consumer));
    }
  }
  return { viewers: clients.size, streams, internal, kinds, clients };
}

/**
 * The counts of several streams together: streams add up, while a client
 * reading more than one of them is still one viewer.
 */
export function mergeCounts(parts: readonly ConsumerCounts[]): ConsumerCounts {
  const kinds = emptyKinds();
  const clients = new Set<ClientKey>();
  let streams = 0;
  let internal = 0;
  for (const part of parts) {
    streams += part.streams;
    internal += part.internal;
    for (const kind of CONSUMER_KINDS) {
      kinds[kind] += part.kinds[kind];
    }
    for (const client of part.clients) {
      clients.add(client);
    }
  }
  return { viewers: clients.size, streams, internal, kinds, clients };
}

function finiteRate(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function sumRates(rates: (number | null)[]): number | null {
  const known = rates.filter((rate): rate is number => rate !== null);
  return known.length > 0 ? known.reduce((sum, rate) => sum + rate, 0) : null;
}

/**
 * The readers of some streams, or null while go2rtc's consumer list is
 * unavailable.
 */
function streamCounts(
  names: readonly string[],
  streams: Go2rtcStreamsResponse | undefined,
): ConsumerCounts | null {
  if (!streams) return null;
  return mergeCounts(
    names.map((name) => countConsumers(streams[name]?.consumers)),
  );
}

/**
 * One row per camera, with its rate, codecs and readers.
 *
 * Args:
 *     cameras: The cameras to list, in order.
 *     state: The go2rtc state, or undefined while it loads.
 *     streams: go2rtc's stream list with consumers, or undefined when it is
 *         unavailable; viewer counts are then null.
 *
 * Returns:
 *     The rows, in the order of `cameras`. A camera go2rtc has no stream for
 *     is `notMeasured`, with no rate and no readers.
 */
export function buildCameraRows(
  cameras: readonly TelemetryCamera[],
  state: Go2rtcStateResponse | undefined,
  streams: Go2rtcStreamsResponse | undefined,
): CameraTelemetry[] {
  return cameras.map((camera) => {
    const configured = (state?.cameras[camera.name]?.streams ?? []).filter(
      (stream) => stream.configured,
    );
    if (configured.length === 0) {
      return {
        camera: camera.name,
        streams: [],
        status: "notMeasured",
        bytesPerSecond: null,
        codecs: [],
        consumers: null,
      };
    }

    const names = configured.map((stream) => stream.name);
    return {
      camera: camera.name,
      streams: names,
      status: camera.inputs.every(isRestreamInput) ? "measured" : "partial",
      bytesPerSecond: sumRates(
        configured.map((stream) => finiteRate(stream.bytes_per_second)),
      ),
      codecs: [...new Set(configured.flatMap((stream) => stream.codecs))],
      consumers: streamCounts(names, streams),
    };
  });
}

/**
 * The card totals, counting a stream two cameras share only once, and a
 * client watching several streams as one viewer.
 *
 * Args:
 *     rows: What `buildCameraRows` returned.
 *     state: The go2rtc state the rows came from.
 *     streams: go2rtc's stream list with consumers, when available.
 */
export function telemetryTotals(
  rows: readonly CameraTelemetry[],
  state: Go2rtcStateResponse | undefined,
  streams: Go2rtcStreamsResponse | undefined,
): TelemetryTotals {
  const byName = new Map<string, Go2rtcStreamState>();
  for (const row of rows) {
    for (const stream of state?.cameras[row.camera]?.streams ?? []) {
      if (row.streams.includes(stream.name)) byName.set(stream.name, stream);
    }
  }

  return {
    bytesPerSecond: sumRates(
      [...byName.values()].map((stream) => finiteRate(stream.bytes_per_second)),
    ),
    consumers: streamCounts([...byName.keys()], streams),
    measuredCameras: rows.filter((row) => row.status !== "notMeasured").length,
    partialCameras: rows.filter((row) => row.status === "partial").length,
    cameras: rows.length,
  };
}

/** The sample the sparklines keep for one read of the go2rtc state. */
export function telemetrySample(
  updated: number,
  rows: readonly CameraTelemetry[],
  totals: TelemetryTotals,
): TelemetrySample {
  return {
    t: updated,
    bytesPerSecond: totals.bytesPerSecond,
    viewers: totals.consumers?.viewers ?? null,
    cameras: Object.fromEntries(
      rows.map((row) => [row.camera, row.bytesPerSecond]),
    ),
  };
}

/**
 * Add a sample and drop the ones that fell out of the window.
 *
 * The backend caches go2rtc for five seconds, so the same `updated` comes
 * back from several reads and is kept once. A time before the newest sample
 * means the server clock moved back, and the window starts over.
 *
 * Args:
 *     buffer: The samples so far, oldest first.
 *     sample: The new sample.
 *     windowSeconds: How far back to keep, measured from the new sample.
 *
 * Returns:
 *     The buffer itself when nothing changed, otherwise a new array.
 */
export function appendSample(
  buffer: readonly TelemetrySample[],
  sample: TelemetrySample,
  windowSeconds: number = TELEMETRY_WINDOW_SECONDS,
): readonly TelemetrySample[] {
  const last = buffer.at(-1);
  if (last && sample.t === last.t) return buffer;
  if (last && sample.t < last.t) return [sample];
  const start = sample.t - windowSeconds;
  return [...buffer.filter((entry) => entry.t >= start), sample];
}

/** The points of one figure across the window, skipping samples without one. */
export function sampleSeries(
  buffer: readonly TelemetrySample[],
  pick: (sample: TelemetrySample) => number | null | undefined,
): SparkSeries {
  const values: number[] = [];
  const times: number[] = [];
  for (const sample of buffer) {
    const value = pick(sample);
    if (typeof value === "number" && Number.isFinite(value)) {
      values.push(value);
      times.push(sample.t);
    }
  }
  return { values, times };
}

/** Where an inference speed sits against the detector graph's thresholds. */
export function latencyLevel(ms: number): LatencyLevel {
  if (ms >= InferenceThreshold.error) return "error";
  if (ms >= InferenceThreshold.warning) return "warning";
  return "ok";
}

/**
 * Each detector's inference speed across the window.
 *
 * Args:
 *     history: Stats samples, oldest first, as `/stats/history` returns them.
 *     windowSeconds: How far back to keep, measured from the newest sample.
 *
 * Returns:
 *     One entry per detector that has a sample in the window, in the order
 *     the detectors first appear.
 */
export function detectorLatencies(
  history: readonly LatencyStatsSample[] | undefined,
  windowSeconds: number = TELEMETRY_WINDOW_SECONDS,
): DetectorLatency[] {
  const samples = (history ?? []).filter(
    (sample) =>
      typeof sample.service?.last_updated === "number" &&
      Number.isFinite(sample.service.last_updated),
  );
  const newest = Math.max(
    ...samples.map((sample) => sample.service?.last_updated ?? 0),
  );
  const start = newest - windowSeconds;

  const series = new Map<string, SparkSeries>();
  for (const sample of samples) {
    const time = sample.service?.last_updated ?? 0;
    if (time < start) continue;
    for (const [name, detector] of Object.entries(sample.detectors ?? {})) {
      const speed = detector.inference_speed;
      if (typeof speed !== "number" || !Number.isFinite(speed)) continue;
      const entry = series.get(name) ?? { values: [], times: [] };
      entry.values.push(speed);
      entry.times.push(time);
      series.set(name, entry);
    }
  }

  return [...series.entries()].map(([name, points]) => {
    const latest = points.values.at(-1) ?? 0;
    return { name, latest, level: latencyLevel(latest), series: points };
  });
}

/** The worst level among the detectors, for the card's tint. */
export function worstLatencyLevel(
  detectors: readonly DetectorLatency[],
): LatencyLevel {
  if (detectors.some((detector) => detector.level === "error")) return "error";
  if (detectors.some((detector) => detector.level === "warning")) {
    return "warning";
  }
  return "ok";
}

/** The kinds with at least one viewer stream, in display order. */
export function viewerKinds(
  counts: ConsumerCounts | null,
): { kind: ConsumerKind; count: number }[] {
  if (!counts) return [];
  return CONSUMER_KINDS.filter((kind) => counts.kinds[kind] > 0).map(
    (kind) => ({ kind, count: counts.kinds[kind] }),
  );
}
