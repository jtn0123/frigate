/**
 * go2rtc source state for GET /api/fork/go2rtc_state (I57).
 *
 * The default is a healthy setup: every camera has one stream named after it,
 * connected and receiving, so the Health drawer only shows trouble when a spec
 * asks for it.
 */

export interface Go2rtcStreamStateMock {
  name: string;
  configured: boolean;
  connected: boolean;
  bytes_received: number;
  bytes_per_second: number | null;
  producers: number;
  consumers: number;
  codecs: string[];
  /** Scheme and host only, as the backend reduces it. */
  source: string | null;
}

export interface Go2rtcStateMock {
  available: boolean;
  updated: number;
  cameras: Record<string, { streams: Go2rtcStreamStateMock[] }>;
}

/** What a spec may override: go2rtc being down, or the streams of a camera. */
export interface Go2rtcStateOverrides {
  available?: boolean;
  cameras?: Record<string, Partial<Go2rtcStreamStateMock>[]>;
}

const DEFAULT_CAMERAS = ["front_door", "backyard", "garage"];

/** A stream go2rtc is connected to and receiving at 512 kbit/s. */
export function go2rtcStream(
  name: string,
  overrides: Partial<Go2rtcStreamStateMock> = {},
): Go2rtcStreamStateMock {
  return {
    name,
    configured: true,
    connected: true,
    bytes_received: 48_000_000,
    bytes_per_second: 64_000,
    producers: 1,
    consumers: 1,
    codecs: ["H264", "AAC"],
    source: "rtsp://10.0.0.5:554",
    ...overrides,
  };
}

export function go2rtcStateFactory(
  overrides: Go2rtcStateOverrides = {},
  now = Date.now() / 1000,
): Go2rtcStateMock {
  const available = overrides.available ?? true;
  const cameras: Go2rtcStateMock["cameras"] = {};
  if (available) {
    const names = new Set([
      ...DEFAULT_CAMERAS,
      ...Object.keys(overrides.cameras ?? {}),
    ]);
    for (const name of names) {
      const streams = overrides.cameras?.[name] ?? [{}];
      cameras[name] = {
        streams: streams.map((stream) =>
          go2rtcStream(stream.name ?? name, stream),
        ),
      };
    }
  }
  return { available, updated: now, cameras };
}
