/**
 * Quiet hours state for GET /api/fork/notifications/schedule (D78).
 *
 * The default is a server on UTC with no UI timezone, so a spec that sets
 * windows reads them on the same clock as the UTC time it freezes.
 */

export interface QuietHoursCameraStateMock {
  quiet: boolean;
  windows: number;
}

export interface NotificationScheduleMock {
  timezone: string;
  source: "ui" | "server";
  now: number;
  cameras: Record<string, QuietHoursCameraStateMock>;
}

const DEFAULT_CAMERAS = ["front_door", "backyard", "garage"];

export function notificationScheduleFactory(
  overrides: Partial<NotificationScheduleMock> = {},
): NotificationScheduleMock {
  return {
    timezone: "UTC",
    source: "server",
    now: Date.now() / 1000,
    cameras: Object.fromEntries(
      DEFAULT_CAMERAS.map((name) => [name, { quiet: false, windows: 0 }]),
    ),
    ...overrides,
  };
}
