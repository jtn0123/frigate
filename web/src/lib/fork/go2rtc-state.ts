/**
 * Fork (I57, I60): reading a go2rtc stream state and a camera's ping for the
 * Health drawer.
 */

import type {
  CameraPingState,
  Go2rtcStreamState,
} from "@/types/fork/go2rtcState";

export type SourceStatus = "connected" | "notConnected" | "notConfigured";

export type ReceiveRate = {
  unit: "bit" | "kbit" | "mbit";
  value: string;
};

export type PingStatus = "reachable" | "lossy" | "unreachable";

/** The one state a stream is shown in. */
export function sourceStatus(
  stream: Pick<Go2rtcStreamState, "configured" | "connected">,
): SourceStatus {
  if (!stream.configured) return "notConfigured";
  return stream.connected ? "connected" : "notConnected";
}

/**
 * A byte rate as a network rate, in the unit that keeps it readable.
 *
 * Args:
 *     bytesPerSecond: The measured rate, or null when there is none yet.
 *
 * Returns:
 *     The value and its unit, or undefined when there is nothing to show.
 */
export function receiveRate(
  bytesPerSecond: number | null | undefined,
): ReceiveRate | undefined {
  if (
    bytesPerSecond === null ||
    bytesPerSecond === undefined ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond < 0
  ) {
    return undefined;
  }
  const bits = bytesPerSecond * 8;
  if (bits < 1000) return { unit: "bit", value: String(Math.round(bits)) };
  if (bits < 999_500) {
    return { unit: "kbit", value: String(Math.round(bits / 1000)) };
  }
  return { unit: "mbit", value: (bits / 1_000_000).toFixed(1) };
}

/**
 * The one state a ping round is shown in.
 *
 * An answer decides first: a round that got any reply is never "unreachable",
 * whatever its loss says.
 */
export function pingStatus(
  ping: Pick<CameraPingState, "reachable" | "loss">,
): PingStatus {
  if (!ping.reachable) return "unreachable";
  return ping.loss > 0 ? "lossy" : "reachable";
}

/**
 * A loss share as a whole percent.
 *
 * Some loss never reads as "0%" and an answered round never as "100%", so the
 * number cannot contradict the state beside it.
 *
 * Args:
 *     loss: Share of the pings left unanswered, 0 to 1.
 *
 * Returns:
 *     The percent without its sign, "0" when there is no usable share.
 */
export function pingLossPercent(loss: number): string {
  if (!Number.isFinite(loss) || loss <= 0) return "0";
  if (loss >= 1) return "100";
  return String(Math.min(99, Math.max(1, Math.round(loss * 100))));
}

/**
 * A round trip in milliseconds, short enough for one line.
 *
 * Args:
 *     ms: The best round trip, or null when no ping was answered.
 *
 * Returns:
 *     One decimal below 100 ms and a whole number from there, or undefined
 *     when there is nothing to show.
 */
export function pingRoundTrip(
  ms: number | null | undefined,
): string | undefined {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return undefined;
  }
  return ms < 99.95 ? ms.toFixed(1) : String(Math.round(ms));
}
