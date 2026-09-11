/**
 * Fork: shared event summary for Review and Explore detail panels (UI9).
 *
 * One row with the object, camera, time, duration and zones so both
 * surfaces read the same way. Hidden when the unifiedEventDetail flag
 * is off.
 */

import {
  CameraNameLabel,
  ZoneNameLabel,
} from "@/components/camera/FriendlyNameLabel";
import { isForkEnabled } from "@/fork/flags";
import { use24HourTime, useFormattedTimestamp } from "@/hooks/use-date-utils";
import { cn } from "@/lib/utils";
import type { EventSummaryData } from "@/lib/fork/event-summary";
import type { FrigateConfig } from "@/types/frigateConfig";
import { getDurationFromTimestamps } from "@/utils/dateUtil";
import { getIconForLabel } from "@/utils/iconUtil";
import { getTranslatedLabel } from "@/utils/i18n";
import { useTranslation } from "react-i18next";
import useSWR from "swr";

type EventSummaryHeaderProps = EventSummaryData & {
  className?: string;
};

export default function EventSummaryHeader({
  camera,
  label,
  subLabel,
  startTime,
  endTime,
  type = "object",
  zones,
  className,
}: EventSummaryHeaderProps) {
  const { t } = useTranslation(["fork", "common"]);
  const { data: config } = useSWR<FrigateConfig>("config");
  const is24Hour = use24HourTime(config);
  const formattedDate = useFormattedTimestamp(
    startTime,
    is24Hour
      ? t("time.formattedTimestampMonthDayYearHourMinute.24hour", {
          ns: "common",
        })
      : t("time.formattedTimestampMonthDayYearHourMinute.12hour", {
          ns: "common",
        }),
    config?.ui.timezone,
  );

  if (!isForkEnabled("unifiedEventDetail")) {
    return null;
  }

  const duration =
    endTime != undefined
      ? getDurationFromTimestamps(startTime, endTime, true)
      : undefined;
  const namedZones = (zones ?? []).filter((zone) => zone.length > 0);

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-secondary-foreground",
        className,
      )}
      data-testid="event-summary-header"
      aria-label={t("eventSummary.label")}
    >
      <span className="flex min-w-0 items-center gap-1.5 font-medium text-primary smart-capitalize">
        {getIconForLabel(label, type, "size-4 shrink-0 text-primary")}
        <span className="truncate">
          {getTranslatedLabel(label, type)}
          {subLabel ? ` (${subLabel})` : ""}
        </span>
      </span>
      <span aria-hidden="true">·</span>
      <CameraNameLabel camera={camera} className="smart-capitalize" />
      <span aria-hidden="true">·</span>
      <span>{formattedDate}</span>
      {duration && (
        <>
          <span aria-hidden="true">·</span>
          <span>{duration}</span>
        </>
      )}
      {namedZones.length > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="flex flex-wrap items-center gap-1">
            {namedZones.map((zone, index) => (
              <span key={zone} className="flex items-center gap-1">
                {index > 0 && <span aria-hidden="true">,</span>}
                <ZoneNameLabel zone={zone} camera={camera} />
              </span>
            ))}
          </span>
        </>
      )}
    </div>
  );
}
