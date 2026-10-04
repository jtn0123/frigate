/**
 * Clock overlay for the wall display (UI19), in the config's time zone and
 * time format.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { useDateLocale } from "@/hooks/use-date-locale";
import { useTimeFormat, useTimezone } from "@/hooks/use-date-utils";
import type { FrigateConfig } from "@/types/frigateConfig";
import { formatUnixTimestampToDateTime } from "@/utils/dateUtil";

export default function KioskClock() {
  const { t } = useTranslation(["fork", "common"]);
  const { data: config } = useSWR<FrigateConfig>("config");
  const timezone = useTimezone(config);
  const timeFormat = useTimeFormat(config);
  const locale = useDateLocale();
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);

  // config.ui.timezone, else the browser's zone (the formatter's default)
  const zone = timezone ? { timezone } : {};
  const time = formatUnixTimestampToDateTime(now, {
    ...zone,
    date_format: t(`time.formattedTimestampHourMinute.${timeFormat}`, {
      ns: "common",
    }),
    locale,
  });
  const date = formatUnixTimestampToDateTime(now, {
    ...zone,
    date_format: t("kiosk.clockDateFormat", { ns: "fork" }),
    locale,
  });

  return (
    <div
      className="pointer-events-none absolute right-4 top-3 z-30 rounded-xl bg-black/55 px-4 py-2 text-right text-white shadow-lg"
      data-testid="kiosk-clock"
    >
      <div className="text-4xl font-semibold tabular-nums leading-tight">
        {time}
      </div>
      <div className="text-sm text-white/80">{date}</div>
    </div>
  );
}
