/**
 * Fork (I58): "Repeated messages" on the Logs page.
 *
 * A camera that keeps failing writes the same line thousands of times, and
 * the log view only folds lines that repeat back to back. This panel shows
 * each repeated warning or error once, per camera, with how often and when,
 * so a dead camera stands out instead of scrolling everything else away.
 */

import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { useApi } from "@/api/fork/client";
import { Button } from "@/components/ui/button";
import { isForkEnabled } from "@/fork/flags";
import { resolveCameraName } from "@/hooks/use-camera-friendly-name";
import { useTimeFormat, useTimezone } from "@/hooks/use-date-utils";
import { useLogSummary } from "@/hooks/fork/use-log-summary";
import {
  isSummaryService,
  mergeLogSummary,
  topCamera,
} from "@/lib/fork/log-summary";
import { cn } from "@/lib/utils";
import type { LogSummaryLevel, LogSummaryRow } from "@/types/fork/logSummary";
import type { LogType } from "@/types/log";
import { formatUnixTimestampToDateTime } from "@/utils/dateUtil";

/** Rows shown; the endpoint already keeps only the most repeated groups. */
const MAX_ROWS = 50;
/** A log that starts this long after the window does gets a note. */
const COVERAGE_SLACK_SECONDS = 600;

const LEVEL_CLASS: Record<LogSummaryLevel, string> = {
  error: "bg-danger",
  warning: "bg-orange-400",
  info: "bg-secondary-foreground",
};

type LogSummaryPanelProps = Readonly<{
  /** The log tab being shown. */
  service: LogType;
  /** The Logs page's camera restriction, empty for none. */
  camera: string;
}>;

export default function LogSummaryPanel({
  service,
  camera,
}: LogSummaryPanelProps) {
  const { t, i18n } = useTranslation("fork");
  const enabled = isForkEnabled("cameraHealth") && isSummaryService(service);
  const { data, error, isLoading, refresh } = useLogSummary(enabled, camera);
  const { data: config } = useApi("/config");
  const timezone = useTimezone(config);
  const timeFormat = useTimeFormat(config);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  const rows = useMemo(
    () =>
      data && isSummaryService(service)
        ? mergeLogSummary(data.groups, service)
        : [],
    [data, service],
  );

  if (!enabled) return null;

  const number = new Intl.NumberFormat(i18n.language);
  const hours = data?.hours ?? 24;
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const top = topCamera(rows);
  // Only the frigate log can be restricted to a camera (see the filter hook).
  const canFilter = service === "frigate";
  const source = data?.sources[service];
  const coveredFrom = source?.covered_from ?? null;
  const showCoverage =
    data !== undefined &&
    coveredFrom !== null &&
    coveredFrom > data.start + COVERAGE_SLACK_SECONDS;

  const formatTime = (timestamp: number) =>
    formatUnixTimestampToDateTime(timestamp, {
      // the config may not name one, and the style type takes an absent key
      // rather than an undefined one
      ...(timezone ? { timezone } : {}),
      date_format: t(
        `time.formattedTimestampMonthDayHourMinute.${timeFormat}`,
        { ns: "common" },
      ),
    });

  const levelLabel = (level: LogSummaryLevel) => {
    if (level === "error") return t("logSummary.level.error");
    if (level === "warning") return t("logSummary.level.warning");
    return t("logSummary.level.info");
  };

  const selectCamera = (name: string) => {
    const next = new URLSearchParams(params);
    next.set("camera", name);
    setParams(next);
  };

  let summary: string;
  if (!data) {
    summary = error ? t("logSummary.error") : t("logSummary.loading");
  } else if (rows.length === 0) {
    summary = t("logSummary.none", { hours });
  } else if (top) {
    summary = t("logSummary.summaryTop", {
      count: total,
      total: number.format(total),
      hours,
      camera: resolveCameraName(config, top.camera),
      top: number.format(top.count),
    });
  } else {
    summary = t("logSummary.summary", {
      count: total,
      total: number.format(total),
      hours,
    });
  }

  // More was repeated than the endpoint returned or than is listed here.
  const cut = data?.truncated === true || rows.length > MAX_ROWS;
  const expandable = rows.length > 0;
  const expanded = open && expandable;

  return (
    <section
      className="mt-2 rounded-md border border-secondary bg-background_alt text-sm"
      data-testid="log-summary"
      aria-label={t("logSummary.title")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1">
        <button
          type="button"
          className={cn(
            "flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-x-2 rounded-sm text-left sm:flex-nowrap",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected",
            !expandable && "cursor-default",
          )}
          aria-expanded={expanded}
          aria-controls={bodyId}
          disabled={!expandable}
          onClick={() => setOpen((value) => !value)}
          data-testid="log-summary-toggle"
        >
          {expanded ? (
            <LuChevronDown className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <LuChevronRight
              className={cn("size-4 shrink-0", !expandable && "opacity-40")}
              aria-hidden="true"
            />
          )}
          <span className="shrink-0 font-medium">{t("logSummary.title")}</span>
          <span
            className="min-w-0 basis-full text-secondary-foreground sm:basis-auto sm:truncate"
            data-testid="log-summary-line"
          >
            {summary}
          </span>
        </button>
        {!data && !isLoading && error !== undefined && (
          <Button size="sm" variant="ghost" onClick={refresh}>
            {t("errorState.retry")}
          </Button>
        )}
      </div>

      {expanded && (
        <div
          id={bodyId}
          className="max-h-64 overflow-auto border-t border-secondary"
        >
          <table className="w-full table-fixed border-collapse text-left">
            <caption className="sr-only">
              {t("logSummary.caption", { hours })}
            </caption>
            <thead className="sticky top-0 bg-background_alt text-xs text-secondary-foreground">
              <tr>
                <th scope="col" className="w-28 px-2 py-1 font-medium md:w-40">
                  {t("logSummary.column.camera")}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t("logSummary.column.message")}
                </th>
                <th
                  scope="col"
                  className="w-20 px-2 py-1 text-right font-medium"
                >
                  {t("logSummary.column.count")}
                </th>
                <th
                  scope="col"
                  className="hidden w-36 px-2 py-1 font-medium md:table-cell"
                >
                  {t("logSummary.column.first")}
                </th>
                <th
                  scope="col"
                  className="hidden w-36 px-2 py-1 font-medium sm:table-cell"
                >
                  {t("logSummary.column.last")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map((row) => (
                <SummaryRow
                  key={row.key}
                  row={row}
                  name={
                    row.camera
                      ? resolveCameraName(config, row.camera)
                      : t("logSummary.noCamera")
                  }
                  level={levelLabel(row.level)}
                  count={number.format(row.count)}
                  first={formatTime(row.first)}
                  last={formatTime(row.last)}
                  filterLabel={
                    canFilter && row.camera && row.camera !== camera
                      ? t("logSummary.filterTo", {
                          camera: resolveCameraName(config, row.camera),
                        })
                      : undefined
                  }
                  onSelect={selectCamera}
                />
              ))}
            </tbody>
          </table>
          {(showCoverage || cut) && (
            <p className="border-t border-secondary px-2 py-1 text-xs text-secondary-foreground">
              {[
                showCoverage
                  ? t("logSummary.coverage", { time: formatTime(coveredFrom) })
                  : "",
                cut ? t("logSummary.truncated") : "",
              ]
                .filter(Boolean)
                .join(" ")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

type SummaryRowProps = Readonly<{
  row: LogSummaryRow;
  name: string;
  level: string;
  count: string;
  first: string;
  last: string;
  /** Set when choosing the row restricts the log to its camera. */
  filterLabel: string | undefined;
  onSelect: (camera: string) => void;
}>;

function SummaryRow({
  row,
  name,
  level,
  count,
  first,
  last,
  filterLabel,
  onSelect,
}: SummaryRowProps) {
  return (
    <tr
      className={cn(
        "relative border-t border-secondary/60 align-top",
        filterLabel && "hover:bg-secondary/40",
      )}
      data-testid="log-summary-row"
    >
      <th scope="row" className="px-2 py-1 font-normal">
        {filterLabel && row.camera ? (
          // The button's ::after covers the row, so the whole row is the
          // click target while the control stays a real, focusable button.
          <button
            type="button"
            className="max-w-full truncate rounded-sm text-left underline-offset-2 after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected"
            title={filterLabel}
            aria-label={filterLabel}
            onClick={() => onSelect(row.camera as string)}
          >
            {name}
          </button>
        ) : (
          <span className="block truncate">{name}</span>
        )}
      </th>
      <td className="break-words px-2 py-1 font-mono text-xs">
        <span
          className={cn(
            "mr-1.5 inline-block size-2 rounded-full align-middle",
            LEVEL_CLASS[row.level],
          )}
          aria-hidden="true"
        />
        <span className="sr-only">{level} </span>
        {row.message}
      </td>
      <td className="px-2 py-1 text-right tabular-nums">{count}</td>
      <td className="hidden px-2 py-1 text-xs md:table-cell">{first}</td>
      <td className="hidden px-2 py-1 text-xs sm:table-cell">{last}</td>
    </tr>
  );
}
