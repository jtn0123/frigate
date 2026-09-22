/** Format telemetry times the way the rest of the app formats times. */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { FrigateConfig } from "@/types/frigateConfig";
import { formatUnixTimestampToDateTime } from "@/utils/dateUtil";

/** "medium" carries seconds, "short" stops at the minute. */
export type MetricTimeStyle = "medium" | "short";

/**
 * Return a formatter for unix-second timestamps that uses the configured UI
 * time zone and time format and the current language, instead of the
 * browser's time zone.
 *
 * Returns:
 *     A function taking unix seconds, whether to include the date, and how
 *     precise the time should be.
 */
export function useMetricTimeFormatter(): (
  unixSeconds: number,
  withDate?: boolean,
  timeStyle?: MetricTimeStyle,
) => string {
  const { i18n } = useTranslation();
  const { data: config } = useSWR<FrigateConfig>("config", {
    revalidateOnFocus: false,
  });
  const timezone = config?.ui.timezone;
  const timeFormat = config?.ui.time_format ?? "browser";
  const locale = i18n.language;

  return useCallback(
    (
      unixSeconds: number,
      withDate = true,
      timeStyle: MetricTimeStyle = "medium",
    ) =>
      formatUnixTimestampToDateTime(unixSeconds, {
        ...(timezone ? { timezone } : {}),
        // A date beside a time is "medium": it spells the month and the full
        // year, as the rest of the app does. "short" would print a two-digit
        // year ("1/1/26"). An axis label with no date stays short.
        ...(withDate
          ? {
              date_style:
                timeStyle === "short"
                  ? ("short" as const)
                  : ("medium" as const),
            }
          : {}),
        time_format: timeFormat,
        time_style: timeStyle,
        locale,
      }),
    [timezone, timeFormat, locale],
  );
}
