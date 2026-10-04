/** Fork (D78): the clock notification quiet hours run on. */

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";

import {
  pickScheduleZone,
  type ScheduleZone,
} from "@/lib/fork/notification-schedule";
import type { components } from "@/types/fork/api.gen";

export type NotificationScheduleResponse =
  components["schemas"]["NotificationScheduleResponse"];

/** The clock ticks on every half minute, so a badge flips as its minute starts. */
const TICK_MS = 30_000;
/** Land just past the boundary rather than a hair before it. */
const TICK_SLACK_MS = 50;

/**
 * Read the timezone the server reads quiet hours in, and its state per camera.
 *
 * Args:
 *     enabled: Whether to fetch; the endpoint is admin only.
 *
 * Returns:
 *     The response once it has loaded.
 */
export function useNotificationSchedule(
  enabled: boolean,
): NotificationScheduleResponse | undefined {
  // Not `useApi`: the typed client only names paths it has migrated.
  const { data } = useSWR<NotificationScheduleResponse>(
    enabled ? "fork/notifications/schedule" : null,
    { revalidateOnFocus: false, refreshInterval: 5 * 60_000 },
  );
  return data;
}

/**
 * The timezone quiet hours run on.
 *
 * Args:
 *     uiZone: `ui.timezone` from the loaded config.
 *     enabled: Whether to ask the server; the endpoint is admin only.
 */
export function useScheduleZone(
  uiZone: string | undefined,
  enabled: boolean,
): ScheduleZone {
  const schedule = useNotificationSchedule(enabled);
  return useMemo(() => pickScheduleZone(uiZone, schedule), [uiZone, schedule]);
}

/**
 * The current time, refreshed on each half minute of the clock.
 *
 * Ticks line up with the minute rather than with when the page opened, so a
 * window that starts at 20:38 shows as quiet at 20:38:00, not up to 30
 * seconds later.
 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const wait = TICK_MS - (Date.now() % TICK_MS) + TICK_SLACK_MS;
      timer = setTimeout(() => {
        setNow(new Date());
        schedule();
      }, wait);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return now;
}
