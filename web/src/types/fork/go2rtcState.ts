/**
 * Fork (I57): the /fork/go2rtc_state response behind the Health drawer.
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

export type Go2rtcCameraState = {
  streams: Go2rtcStreamState[];
};

export type Go2rtcStateResponse = {
  /** False when go2rtc did not answer; `cameras` is empty then. */
  available: boolean;
  updated: number;
  cameras: Record<string, Go2rtcCameraState>;
};
