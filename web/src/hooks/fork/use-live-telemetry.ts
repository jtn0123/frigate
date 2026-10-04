/**
 * Fork (UI146): the reads behind the System page's live telemetry cards, and
 * the rolling window their sparklines draw.
 *
 * Three reads, all paused by SWR while the browser tab is hidden:
 * - the fork's go2rtc state, for each camera's receive rate;
 * - upstream's go2rtc stream list, for who is reading each stream;
 * - the detectors' inference speed from the stats history.
 */

import { useMemo, useState } from "react";
import useSWR from "swr";

import { useApi } from "@/api/fork/client";
import { useGo2rtcState } from "@/hooks/fork/use-go2rtc-state";
import { useInlineReadError } from "@/hooks/fork/use-inline-read-error";
import {
  appendSample,
  buildCameraRows,
  detectorLatencies,
  sampleSeries,
  telemetryCameras,
  telemetrySample,
  telemetryTotals,
  type CameraTelemetry,
  type DetectorLatency,
  type SparkSeries,
  type TelemetrySample,
  type TelemetryTotals,
} from "@/lib/fork/live-telemetry";
import type { Go2rtcStreamsResponse } from "@/types/fork/go2rtcStreams";
import type { FrigateConfig } from "@/types/frigateConfig";

/**
 * How often go2rtc is read. The backend caches go2rtc's answer for five
 * seconds, so asking more often only returns the same snapshot.
 */
export const TELEMETRY_REFRESH_MS = 5_000;

/** Stats are sampled every 15 seconds (`FREQUENCY_STATS_POINTS`). */
export const LATENCY_REFRESH_MS = 15_000;

/** Only what the latency card draws, to keep each poll small. */
export const LATENCY_KEYS = "detectors.inference_speed,service.last_updated";

export type ReadStatus = "loading" | "unavailable" | "ready";

export type LiveTelemetry = {
  config: FrigateConfig | undefined;
  rows: CameraTelemetry[];
  totals: TelemetryTotals;
  detectors: DetectorLatency[];
  /** go2rtc state: loading, unreachable (or the read failed), or ready. */
  go2rtcStatus: ReadStatus;
  /** go2rtc's consumer list, behind the viewer counts. */
  viewersStatus: ReadStatus;
  latencyStatus: ReadStatus;
  totalSeries: SparkSeries;
  viewerSeries: SparkSeries;
  cameraSeries: (camera: string) => SparkSeries;
};

function readStatus(
  data: unknown,
  error: unknown,
  usable: boolean = true,
): ReadStatus {
  if (error || (data !== undefined && !usable)) return "unavailable";
  return data === undefined ? "loading" : "ready";
}

/**
 * Read and combine the live telemetry while the General tab shows it.
 *
 * Args:
 *     isActive: Whether to read and keep polling.
 *
 * Returns:
 *     The rows, totals and series the cards draw, with the state of each read.
 */
export function useLiveTelemetry(isActive: boolean): LiveTelemetry {
  const { data: config } = useApi("/config", { revalidateOnFocus: false });
  const state = useGo2rtcState(isActive, TELEMETRY_REFRESH_MS);
  const consumers = useSWR<Go2rtcStreamsResponse>(
    isActive ? "go2rtc/streams" : null,
    {
      revalidateOnFocus: false,
      refreshInterval: TELEMETRY_REFRESH_MS,
      keepPreviousData: true,
    },
  );
  const latency = useApi(isActive ? "/stats/history" : null, {
    params: { keys: LATENCY_KEYS },
    revalidateOnFocus: false,
    refreshInterval: LATENCY_REFRESH_MS,
    keepPreviousData: true,
  });
  // The cards say when go2rtc cannot be read; a toast every poll would
  // repeat it. A stats failure still toasts: the graphs below share it.
  useInlineReadError("fork/go2rtc_state");
  useInlineReadError("go2rtc/streams");

  const go2rtcStatus = readStatus(
    state.data,
    state.error,
    state.data?.available === true,
  );
  const viewersStatus = readStatus(consumers.data, consumers.error);
  const latencyStatus = readStatus(latency.data, latency.error);

  // SWR keeps the last data through an error; a failed read must not keep
  // showing it as current.
  const go2rtc = go2rtcStatus === "ready" ? state.data : undefined;
  const streams = viewersStatus === "ready" ? consumers.data : undefined;
  const history = latencyStatus === "ready" ? latency.data : undefined;

  const cameras = useMemo(() => telemetryCameras(config), [config]);
  const rows = useMemo(
    () => buildCameraRows(cameras, go2rtc, streams),
    [cameras, go2rtc, streams],
  );
  const totals = useMemo(
    () => telemetryTotals(rows, go2rtc, streams),
    [rows, go2rtc, streams],
  );
  const detectors = useMemo(() => detectorLatencies(history), [history]);

  // A new go2rtc snapshot adds one sample. This runs during render, React's
  // pattern for state that follows a changing input, so the sparkline and
  // the number above it always come from the same read.
  const [buffer, setBuffer] = useState<readonly TelemetrySample[]>([]);
  const [seen, setSeen] = useState<number | undefined>(undefined);
  const updated = go2rtc?.updated;
  if (updated !== undefined && updated !== seen) {
    setSeen(updated);
    setBuffer(appendSample(buffer, telemetrySample(updated, rows, totals)));
  }

  const totalSeries = useMemo(
    () => sampleSeries(buffer, (sample) => sample.bytesPerSecond),
    [buffer],
  );
  const viewerSeries = useMemo(
    () => sampleSeries(buffer, (sample) => sample.viewers),
    [buffer],
  );
  const cameraSeries = useMemo(() => {
    const cache = new Map<string, SparkSeries>();
    return (camera: string) => {
      const cached = cache.get(camera);
      if (cached) return cached;
      const series = sampleSeries(buffer, (sample) => sample.cameras[camera]);
      cache.set(camera, series);
      return series;
    };
  }, [buffer]);

  return {
    config,
    rows,
    totals,
    detectors,
    go2rtcStatus,
    viewersStatus,
    latencyStatus,
    totalSeries,
    viewerSeries,
    cameraSeries,
  };
}
