/**
 * Fork (UI131): one camera's window, opened from a row of the Health table.
 *
 * The strip answers "when was it down" at a glance; the log underneath says
 * what happened and links each incident to the logs for that camera.
 */

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LuChevronDown,
  LuChevronUp,
  LuScrollText,
  LuSettings,
} from "react-icons/lu";
import { FaVideo } from "react-icons/fa";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { phoneTouch } from "@/lib/fork/phone";
import { useMetricTimeFormatter } from "@/hooks/fork/use-metric-time";
import {
  incidentDuration,
  incidentKind,
  stripTicks,
  type HealthRow,
} from "@/lib/fork/camera-history";
import type {
  HistoryCellState,
  HistoryRange,
} from "@/types/fork/cameraHistory";

/** Strip colors, worst state per cell. */
const CELL_CLASS: Record<HistoryCellState, string> = {
  ok: "bg-success/50",
  degraded: "bg-orange-500",
  offline: "bg-danger",
  none: "bg-secondary",
};

/** The same dot the table row shows, so the drawer reads as that row opened. */
const STATE_DOT: Record<string, string> = {
  ok: "text-success",
  degraded: "text-orange-400",
  offline: "text-danger",
  disabled: "text-muted-foreground",
  starting: "text-selected",
  unknown: "text-warning",
};

const STATE_BADGE: Record<string, string> = {
  ok: "border-success/40 bg-success/15 text-success",
  degraded: "border-orange-400/40 bg-orange-400/15 text-orange-400",
  offline: "border-danger/40 bg-danger/15 text-danger",
  disabled: "border-transparent bg-secondary text-muted-foreground",
  starting: "border-transparent bg-secondary text-selected",
  unknown: "border-warning/40 bg-secondary text-warning",
};

const LEGEND: HistoryCellState[] = ["ok", "degraded", "offline", "none"];

/**
 * Minutes down, rounded the way the table's badge rounds them.
 *
 * A plain round would print "0 min" next to the row's "1 min" for anything
 * under half a minute, which reads as the drawer contradicting the row.
 */
function downMinutes(seconds: number): number {
  return seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0;
}

function formatFps(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "-";
  return value.toFixed(1);
}

type CameraHealthDrawerProps = {
  row: HealthRow | undefined;
  /** Position within the current ordering, for the "3 of 6" counter. */
  index: number;
  total: number;
  range: HistoryRange;
  start: number;
  end: number;
  cellSeconds: number;
  onClose: () => void;
  onStep: (delta: number) => void;
};

export default function CameraHealthDrawer({
  row,
  index,
  total,
  range,
  start,
  end,
  cellSeconds,
  onClose,
  onStep,
}: Readonly<CameraHealthDrawerProps>) {
  const { t } = useTranslation(["fork", "views/system"]);
  const formatTime = useMetricTimeFormatter();

  if (!row) return null;

  const series = row.series;
  const cameraStats = row.stats;
  const metrics: Array<{ key: string; value: string }> = [
    {
      key: "cameraFps",
      value: cameraStats?.expected_fps
        ? `${formatFps(cameraStats.camera_fps)} / ${cameraStats.expected_fps}`
        : formatFps(cameraStats?.camera_fps),
    },
    { key: "detectionFps", value: formatFps(cameraStats?.detection_fps) },
    { key: "skippedFps", value: formatFps(cameraStats?.skipped_fps) },
    {
      key: "detectorShare",
      value: row.share === undefined ? "-" : `${row.share}%`,
    },
    {
      key: "reconnects",
      value: String(cameraStats?.reconnects_last_hour ?? "-"),
    },
    { key: "stalls", value: String(cameraStats?.stalls_last_hour ?? "-") },
  ];
  const states = series?.states ?? [];
  const ticks = stripTicks(start, end);
  const incidents = [...(series?.incidents ?? [])].reverse();

  return (
    // The URL already carries which camera is open, so the back gesture
    // closes the drawer by changing it. Letting the sheet push its own entry
    // too would take two presses to leave the tab.
    <Sheet
      open
      enableHistoryBack={false}
      onOpenChange={(open) => !open && onClose()}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl"
        data-testid="camera-health-drawer"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-secondary p-4 pr-12">
          <span
            className={cn(
              "size-2.5 shrink-0 rounded-full bg-current",
              STATE_DOT[row.state] ?? "text-muted-foreground",
            )}
          />
          <SheetTitle className="min-w-0 truncate text-lg smart-capitalize">
            {row.label}
          </SheetTitle>
          <Badge variant="outline" className={STATE_BADGE[row.state]}>
            {t(`cameraHealth.state.${row.state}`)}
          </Badge>
          <SheetDescription className="sr-only">
            {t("cameraHealth.drawer.description", { camera: row.label })}
          </SheetDescription>
          {total > 1 && (
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("cameraHealth.drawer.previous")}
                onClick={() => onStep(-1)}
                className={cn(phoneTouch && "min-h-11 min-w-11")}
              >
                <LuChevronUp className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("cameraHealth.drawer.next")}
                onClick={() => onStep(1)}
                className={cn(phoneTouch && "min-h-11 min-w-11")}
              >
                <LuChevronDown className="size-4" />
              </Button>
              <span className="px-1 text-xs tabular-nums text-muted-foreground">
                {t("cameraHealth.drawer.position", {
                  index: index + 1,
                  total,
                })}
              </span>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <dl className="flex flex-wrap gap-x-10 gap-y-4">
            <div className="flex flex-col">
              <dt className="text-xs text-muted-foreground">
                {t("cameraHealth.drawer.uptime", {
                  range: t(`cameraHealth.range.${range}`),
                })}
              </dt>
              <dd
                className={cn(
                  "text-3xl font-semibold tabular-nums",
                  row.uptime >= 100 ? "text-primary" : "text-orange-400",
                )}
              >
                {t("cameraHealth.percent", {
                  value: Number.isInteger(row.uptime)
                    ? String(row.uptime)
                    : row.uptime.toFixed(1),
                })}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-xs text-muted-foreground">
                {t("cameraHealth.drawer.downtime")}
              </dt>
              <dd className="text-3xl font-semibold tabular-nums">
                {t("cameraHealth.minutes", {
                  count: downMinutes(row.downtime),
                })}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-xs text-muted-foreground">
                {t("cameraHealth.drawer.incidents")}
              </dt>
              <dd className="text-3xl font-semibold tabular-nums">
                {incidents.length}
              </dd>
            </div>
          </dl>

          {row.reasons.length > 0 && (
            <p
              className="mt-4 text-sm text-muted-foreground"
              data-testid="camera-health-reason"
            >
              {row.reasons
                .map((reason) => t(`cameraHealth.reason.${reason}`))
                .join(", ")}
            </p>
          )}
          {row.notes.length > 0 && (
            <p
              className="mt-1 text-sm text-muted-foreground"
              data-testid="camera-health-note"
            >
              {row.notes.map((note) => (
                <span key={note}>
                  {t(`cameraHealth.note.${note}`)}
                  {/* softwareDecoding is the only note, and the one with a time */}
                  {!!row.stats?.hwaccel_fallback_since && (
                    <>
                      {" · "}
                      {formatTime(row.stats.hwaccel_fallback_since)}
                    </>
                  )}
                </span>
              ))}
            </p>
          )}

          <dl
            className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4"
            data-testid="camera-health-metrics"
          >
            {metrics.map((metric) => (
              <div key={metric.key} className="flex flex-col">
                <dt className="text-xs text-muted-foreground">
                  {t(`cameraHealth.metric.${metric.key}`)}
                </dt>
                <dd className="font-medium tabular-nums">{metric.value}</dd>
              </div>
            ))}
          </dl>

          <section className="mt-6" aria-label={t("cameraHealth.drawer.strip")}>
            <div className="flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground">
              <span>{t("cameraHealth.drawer.strip")}</span>
              <span className="normal-case tracking-normal">
                {cellSeconds >= 3600 && cellSeconds % 3600 === 0
                  ? t("cameraHealth.drawer.cellHours", {
                      count: cellSeconds / 3600,
                    })
                  : t("cameraHealth.drawer.cell", {
                      count: Math.round(cellSeconds / 60),
                    })}
              </span>
            </div>
            {states.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {t("cameraHealth.drawer.noHistory")}
              </p>
            ) : (
              <>
                <div className="mt-2 flex gap-0.5" data-testid="uptime-strip">
                  {states.map((state, cell) => (
                    <div
                      key={start + cell * cellSeconds}
                      className={cn(
                        "h-11 flex-1 rounded-sm",
                        CELL_CLASS[state],
                      )}
                      title={`${formatTime(
                        start + cell * cellSeconds,
                        false,
                        "short",
                      )} · ${t("cameraHealth.cell." + state)}`}
                      data-state={state}
                    />
                  ))}
                </div>
                <div className="flex justify-between pt-1.5 text-xs tabular-nums text-muted-foreground">
                  {ticks.map((tick) => (
                    <span key={tick}>
                      {formatTime(tick, range === "7d", "short")}
                    </span>
                  ))}
                </div>
              </>
            )}
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
              {LEGEND.map((state) => (
                <li key={state} className="flex items-center gap-1.5">
                  <span
                    className={cn("size-2.5 rounded-sm", CELL_CLASS[state])}
                  />
                  {t("cameraHealth.cell." + state)}
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-6" aria-label={t("cameraHealth.drawer.log")}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("cameraHealth.drawer.log")}
            </h3>
            {incidents.length === 0 ? (
              <p
                className="mt-2 rounded-lg border border-secondary p-4 text-sm text-muted-foreground"
                data-testid="camera-health-no-incidents"
              >
                {t("cameraHealth.drawer.clean")}
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {incidents.map((incident) => {
                  const { family, reason } = incidentKind(incident);
                  const seconds = incidentDuration(incident);
                  return (
                    <li
                      key={`${incident.kind}-${incident.start}`}
                      className="flex gap-3 rounded-lg border border-secondary p-3"
                      data-testid="camera-health-incident"
                    >
                      <span
                        className={cn(
                          "mt-1.5 size-2.5 shrink-0 rounded-sm",
                          family === "outage" ? "bg-danger" : "bg-yellow-500",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span
                            className={cn(
                              "font-semibold",
                              family === "outage"
                                ? "text-danger"
                                : "text-orange-400",
                            )}
                          >
                            {family === "outage"
                              ? t("cameraHealth.incident.outage")
                              : t("cameraHealth.incident.restart", {
                                  kind: t(
                                    `cameraHealth.restartKind.${reason}`,
                                    {
                                      defaultValue: reason,
                                    },
                                  ),
                                })}
                          </span>
                          <span className="tabular-nums">
                            {formatTime(incident.start, range === "7d")}
                          </span>
                          <span className="text-muted-foreground">
                            {seconds === undefined
                              ? t("cameraHealth.incident.ongoing")
                              : t("cameraHealth.minutes", {
                                  count: Math.max(1, Math.round(seconds / 60)),
                                })}
                          </span>
                        </div>
                        {!!incident.reason && (
                          <p className="mt-0.5 text-sm text-muted-foreground">
                            {incident.reason}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-secondary p-4">
          <Button asChild variant="secondary" className="flex-1">
            <Link to={`/#${row.camera}`}>
              <FaVideo className="mr-2 size-3.5" />
              {t("cameraHealth.openLive")}
            </Link>
          </Button>
          {/* The Logs page has no camera filter, so this only opens the
              Frigate log, where a camera's ffmpeg errors are written. */}
          <Button asChild variant="secondary" className="flex-1">
            <Link to="/logs">
              <LuScrollText className="mr-2 size-3.5" />
              {t("cameraHealth.viewLogs")}
            </Link>
          </Button>
          <Button asChild variant="secondary" className="flex-1">
            <Link to={`/settings?page=cameraFfmpeg&camera=${row.camera}`}>
              <LuSettings className="mr-2 size-3.5" />
              {t("cameraHealth.openSettings")}
            </Link>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
