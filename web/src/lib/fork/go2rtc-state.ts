/** Fork (I57): reading a go2rtc stream state for the Health drawer. */

import type { Go2rtcStreamState } from "@/types/fork/go2rtcState";

export type SourceStatus = "connected" | "notConnected" | "notConfigured";

export type ReceiveRate = {
  unit: "bit" | "kbit" | "mbit";
  value: string;
};

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
