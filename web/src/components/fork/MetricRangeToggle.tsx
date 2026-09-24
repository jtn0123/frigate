/**
 * Fork (D54): picks how far back the System page's graphs reach.
 *
 * "Live" is the in-memory window Frigate has always graphed, about 20
 * minutes of 15 s samples. The longer ranges come from the stored history,
 * averaged into buckets, so the caption says how much time a point covers.
 */

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { phoneTouch } from "@/lib/fork/phone";
import {
  METRIC_RANGES,
  isMetricRange,
  type MetricRange,
} from "@/hooks/fork/use-system-metrics-history";

/** A caption key, with the count its plural form needs. */
type RangeNote = { key: string; count?: number };

type MetricRangeToggleProps = {
  range: MetricRange;
  onRangeChange: (range: MetricRange) => void;
  /** Seconds each point averages, absent on the live range. */
  resolution?: number | undefined;
  status: string;
};

/** Which caption the toggle shows, or nothing while a range is loading. */
// eslint-disable-next-line react-refresh/only-export-components
export function rangeNote(
  range: MetricRange,
  status: string,
  resolution: number | undefined,
): RangeNote | undefined {
  if (status === "disabled") {
    return { key: "systemMetrics.range.disabled" };
  }

  if (status === "unavailable") {
    return { key: "systemMetrics.range.unavailable" };
  }

  if (status === "empty") {
    return { key: "systemMetrics.range.empty" };
  }

  if (range === "live") {
    return { key: "systemMetrics.range.liveNote" };
  }

  if (!resolution) {
    return undefined;
  }

  if (resolution < 3600) {
    return {
      key: "systemMetrics.range.averagedMinutes",
      count: Math.round(resolution / 60),
    };
  }

  return {
    key: "systemMetrics.range.averagedHours",
    count: Math.round(resolution / 3600),
  };
}

export default function MetricRangeToggle({
  range,
  onRangeChange,
  resolution,
  status,
}: Readonly<MetricRangeToggleProps>) {
  const { t } = useTranslation(["fork"]);
  const note = rangeNote(range, status, resolution);
  // `count` only belongs on the keys that have a plural form
  const caption =
    note &&
    (note.count === undefined
      ? t(note.key)
      : t(note.key, { count: note.count }));

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label className="flex items-center gap-2 text-sm">
        {t("systemMetrics.range.label")}
        <select
          data-testid="metric-range"
          className={cn(
            "rounded-md border border-secondary bg-background px-3 py-2",
            phoneTouch && "min-h-11",
          )}
          value={range}
          onChange={(event) => {
            if (isMetricRange(event.target.value)) {
              onRangeChange(event.target.value);
            }
          }}
        >
          {METRIC_RANGES.map((option) => (
            <option key={option} value={option}>
              {t(`systemMetrics.range.option.${option}`)}
            </option>
          ))}
        </select>
      </label>
      <p
        className="text-xs text-muted-foreground"
        data-testid="metric-range-note"
      >
        {caption}
      </p>
    </div>
  );
}
