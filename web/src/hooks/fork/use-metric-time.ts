/** Format telemetry times the way the rest of the app formats times. */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { FrigateConfig } from "@/types/frigateConfig";
import { formatUnixTimestampToDateTime } from "@/utils/dateUtil";

/**
 * Return a formatter for unix-second timestamps that uses the configured UI
 * time zone and time format and the current language, instead of the
 * browser's time zone.
 *
 * Returns:
 *     A function taking unix seconds and whether to include the date.
 */
export function useMetricTimeFormatter(): (
  unixSeconds: number,
  withDate?: boolean,
) => string {
  const { i18n } = useTranslation();
  const { data: config } = useSWR<FrigateConfig>("config", {
    revalidateOnFocus: false,
  });
  const timezone = config?.ui.timezone;
  const timeFormat = config?.ui.time_format ?? "browser";
  const locale = i18n.language;

  return useCallback(
    (unixSeconds: number, withDate = true) =>
      formatUnixTimestampToDateTime(unixSeconds, {
        ...(timezone ? { timezone } : {}),
        // "medium" spells the month and the full year, as the rest of the
        // app does when it shows a date beside a time. "short" would print
        // a two-digit year ("1/1/26")
        ...(withDate ? { date_style: "medium" as const } : {}),
        time_format: timeFormat,
        time_style: "medium",
        locale,
      }),
    [timezone, timeFormat, locale],
  );
}
