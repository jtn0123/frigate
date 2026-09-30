/**
 * Fork (I57, I60): the /fork/go2rtc_state response behind the Health drawer.
 *
 * Hand-written until the endpoint is in api.gen.ts.
 */

export type Go2rtcStreamState = {
  name: string;
  /** False when go2rtc has no stream by this name. */
  configured: boolean;
  /** True when a producer has tracks or has received bytes. */
  connected: boolean;
  bytes_received: number;
  /** Null on the first sample and after the counter restarted. */
  bytes_per_second: number | null;
  producers: number;
  consumers: number;
  codecs: string[];
  /** Scheme and host only; the backend never sends the source URL. */
  source: string | null;
};

/** Fork (I60): the last round of pings Frigate sent to the camera's host. */
export type CameraPingState = {
  /** True when any ping of the round was answered. */
  reachable: boolean;
  /** Best round trip in milliseconds, null when none was answered. */
  ms: number | null;
  /** Share of the round's pings left unanswered, 0 to 1. */
  loss: number;
  /** "tcp" when the stream port decided because ICMP could not. */
  method: "icmp" | "tcp";
  /** Unix seconds of the round. */
  checked: number;
};

export type Go2rtcCameraState = {
  streams: Go2rtcStreamState[];
  /** Null or missing before the first round, and for a camera with no host. */
  ping?: CameraPingState | null;
};

export type Go2rtcStateResponse = {
  /** False when go2rtc did not answer; `cameras` is empty then. */
  available: boolean;
  updated: number;
  cameras: Record<string, Go2rtcCameraState>;
};
