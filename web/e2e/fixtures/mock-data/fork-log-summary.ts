/**
 * Repeated log lines for GET /api/fork/log_summary (I58).
 *
 * The default is a quiet day: nothing repeated, so the Logs page's panel
 * stays a single collapsed line unless a spec asks for trouble.
 */

export type LogSummaryServiceMock = "frigate" | "go2rtc";

export interface LogSummaryGroupMock {
  camera: string | null;
  service: LogSummaryServiceMock;
  hour: number;
  level: "info" | "warning" | "error";
  count: number;
  first: number;
  last: number;
  message: string;
  signature: string;
}

export interface LogSummarySourceMock {
  available: boolean;
  partial: boolean;
  lines: number;
  covered_from: number | null;
  covered_to: number | null;
}

export interface LogSummaryMock {
  hours: number;
  start: number;
  end: number;
  covered_from: number | null;
  sources: Record<LogSummaryServiceMock, LogSummarySourceMock>;
  total: number;
  unattributed: number;
  cameras: Record<string, number>;
  truncated: boolean;
  groups: LogSummaryGroupMock[];
}

export interface LogSummaryOverrides {
  groups?: Partial<LogSummaryGroupMock>[];
  truncated?: boolean;
}

/** One camera's message repeating within an hour. */
export function logSummaryGroup(
  now: number,
  overrides: Partial<LogSummaryGroupMock> = {},
): LogSummaryGroupMock {
  const hour = Math.floor(now / 3600) * 3600 - 3600;
  return {
    camera: "garage",
    service: "frigate",
    hour,
    level: "info",
    count: 2,
    first: hour + 60,
    last: hour + 3000,
    message: "No frames received from garage in 20 seconds. Exiting ffmpeg...",
    signature: "No frames received from garage in # seconds. Exiting ffmpeg...",
    ...overrides,
  };
}

/** A garage camera stuck in a restart loop, plus quieter neighbors. */
export function noisyLogSummaryGroups(): Partial<LogSummaryGroupMock>[] {
  return [
    { count: 31_000 },
    {
      count: 734,
      level: "error",
      message: "Error opening input file rtsp://127.0.0.1:8554/garage.",
      signature: "Error opening input file rtsp://#.#.#.#:#/garage.",
    },
    {
      camera: "backyard",
      count: 12,
      level: "warning",
      message: "Backyard stream stalled",
      signature: "Backyard stream stalled",
    },
    {
      camera: null,
      count: 3,
      level: "warning",
      message: "Something without a camera failed",
      signature: "Something without a camera failed",
    },
    {
      service: "go2rtc",
      count: 5_000,
      level: "warning",
      message:
        '[rtsp] error="streams: exec/rtsp [tcp @ 0x5aa53fd52080] Connection to tcp://10.0.0.42:80 failed: Connection timed out"',
      signature:
        '[rtsp] error="streams: exec/rtsp [tcp @ #] Connection to tcp://#.#.#.#:# failed: Connection timed out"',
    },
  ];
}

export function logSummaryFactory(
  camera: string | null,
  overrides: LogSummaryOverrides = {},
  now = Math.floor(Date.now() / 1000),
): LogSummaryMock {
  const start = now - 24 * 3600;
  const groups = (overrides.groups ?? [])
    .map((group) => logSummaryGroup(now, group))
    .filter((group) => !camera || group.camera === camera)
    .sort((a, b) => b.count - a.count);
  const cameras: Record<string, number> = {};
  for (const group of groups) {
    if (group.camera) {
      cameras[group.camera] = (cameras[group.camera] ?? 0) + group.count;
    }
  }
  const source: LogSummarySourceMock = {
    available: true,
    partial: false,
    lines: 1000,
    covered_from: start,
    covered_to: now,
  };
  return {
    hours: 24,
    start,
    end: now,
    covered_from: start,
    sources: { frigate: source, go2rtc: source },
    total: groups.reduce((sum, group) => sum + group.count, 0),
    unattributed: groups
      .filter((group) => !group.camera)
      .reduce((sum, group) => sum + group.count, 0),
    cameras,
    truncated: overrides.truncated ?? false,
    groups,
  };
}
