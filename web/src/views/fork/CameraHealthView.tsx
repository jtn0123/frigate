/**
 * Fork (UI131): the System > Health tab.
 *
 * One row per camera over a window the backend keeps on disk, worst first,
 * with the summary above it answering "is anything wrong" before any reading.
 * Everything a single camera needs is in the drawer behind its row.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuActivity,
  LuArrowDown,
  LuArrowUp,
  LuChevronRight,
  LuHeartPulse,
} from "react-icons/lu";

import { useApi } from "@/api/fork/client";
import ErrorState from "@/components/fork/ErrorState";
import CameraHealthDrawer from "@/components/fork/CameraHealthDrawer";
import Sparkline from "@/components/fork/Sparkline";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useViewQuery } from "@/hooks/use-view-query";
import { useAutoFrigateStats } from "@/hooks/use-stats";
import { useCameraHistory } from "@/hooks/fork/use-camera-history";
import { useCamerasEnabled } from "@/hooks/fork/use-cameras-enabled";
import { resolveCameraName } from "@/hooks/use-camera-friendly-name";
import { cn } from "@/lib/utils";
import { phoneTouch } from "@/lib/fork/phone";
import {
  computeCameraHealth,
  detectorShare,
  enabledFromWs,
  type CameraHealthState,
} from "@/lib/fork/camera-health";
import {
  DEFAULT_HISTORY_RANGE,
  RANGE_SECONDS,
  hasIssues,
  isHistoryRange,
  needsAttention,
  ranClean,
  sortRows,
  sparklinePoints,
  summarizeIssues,
  type HealthRow,
  type SortDirection,
  type SortKey,
} from "@/lib/fork/camera-history";
import type { HistoryRange } from "@/types/fork/cameraHistory";
import { isReplayCamera } from "@/utils/cameraUtil";
import { wrapAsync } from "@/utils/promise";

const STATE_DOT: Record<CameraHealthState, string> = {
  ok: "text-success",
  degraded: "text-orange-400",
  offline: "text-danger",
  disabled: "text-muted-foreground",
  starting: "text-selected",
  unknown: "text-warning",
};

const STATE_BADGE: Record<CameraHealthState, string> = {
  ok: "border-success/40 bg-success/15 text-success",
  degraded: "border-orange-400/40 bg-orange-400/15 text-orange-400",
  offline: "border-danger/40 bg-danger/15 text-danger",
  disabled: "border-transparent bg-secondary text-muted-foreground",
  starting: "border-transparent bg-secondary text-selected",
  unknown: "border-warning/40 bg-secondary text-warning",
};

/** How long a stats snapshot stays usable before the tab calls it stale. */
const STATS_FRESH_SECONDS = 90;
/** How often the freshness clock is re-read. */
const FRESHNESS_TICK_MS = 10_000;
/** How many cameras the summary line names before it stops. */
const SUMMARY_CAMERAS = 2;

type Scope = "attention" | "all";

function formatFps(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "-";
  return value.toFixed(1);
}

/** Whole percent when it lands on one, so "100%" does not read as "100.0%". */
function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function minutesOf(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

export default function CameraHealthView() {
  const { t } = useTranslation(["fork", "views/system"]);
  const [params, updateView] = useViewQuery();

  const rangeParam = params.get("range") ?? "";
  const range = isHistoryRange(rangeParam) ? rangeParam : DEFAULT_HISTORY_RANGE;
  const scope: Scope =
    params.get("scope") === "attention" ? "attention" : "all";
  // The open camera has its own parameter: `camera` is a System-wide view
  // selection that survives a tab change, so honoring it here would cover
  // the page with a modal drawer the moment a shared link landed on Health.
  const selectedCamera = params.get("health") ?? "";
  const [sortKey, setSortKey] = useState<SortKey>("state");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");

  const configRequest = useApi("/config", { revalidateOnFocus: false });
  const { data: config, mutate } = configRequest;
  const configError: unknown = configRequest.error;
  const stats = useAutoFrigateStats();
  const history = useCameraHistory(range);

  const [lastTick, setLastTick] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setLastTick(Date.now()), FRESHNESS_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // Evaluate against the current clock when new stats arrive between ticks.
  const now = Math.max(lastTick, Date.now());
  const fresh =
    stats &&
    Number.isFinite(stats.service.last_updated) &&
    now / 1000 - stats.service.last_updated <= STATS_FRESH_SECONDS &&
    stats.service.last_updated <= now / 1000 + 5;
  const liveStats = fresh ? stats : undefined;

  const cameras = useMemo(
    () =>
      Object.values(config?.cameras ?? {})
        .filter((camera) => !isReplayCamera(camera.name))
        .filter((camera) => camera.enabled_in_config)
        .sort(
          (a, b) => a.ui.order - b.ui.order || a.name.localeCompare(b.name),
        ),
    [config],
  );
  const cameraNames = useMemo(
    () => cameras.map((camera) => camera.name),
    [cameras],
  );
  const enabledStates = useCamerasEnabled(cameraNames);

  const rows: HealthRow[] = useMemo(
    () =>
      cameras.map((camera) => {
        const cameraStats = liveStats?.cameras[camera.name];
        const series = history.data?.cameras[camera.name];
        const health = computeCameraHealth(
          {
            enabled: enabledFromWs(enabledStates[camera.name], camera.enabled),
          },
          cameraStats,
          stats?.service.uptime,
        );
        return {
          camera: camera.name,
          label: config ? resolveCameraName(config, camera) : camera.name,
          state: health.state,
          reasons: health.reasons,
          notes: health.notes,
          stats: cameraStats,
          fps: cameraStats?.camera_fps,
          expectedFps: cameraStats?.expected_fps,
          share: detectorShare(liveStats, camera.name),
          uptime: series?.uptime ?? 100,
          downtime: series?.downtime ?? 0,
          issues: summarizeIssues(series, cameraStats),
          series,
        };
      }),
    [cameras, config, enabledStates, history.data, liveStats, stats],
  );

  const visible = useMemo(
    () =>
      sortRows(
        scope === "attention" ? rows.filter(needsAttention) : rows,
        sortKey,
        sortDir,
      ),
    [rows, scope, sortKey, sortDir],
  );

  const attentionCount = rows.filter(needsAttention).length;
  const hasHistory = Object.keys(history.data?.cameras ?? {}).length > 0;
  const end = history.data?.end ?? now / 1000;
  const start = history.data?.start ?? end - RANGE_SECONDS[range];
  const cellSeconds =
    history.data?.cell_seconds ?? Math.round(RANGE_SECONDS[range] / 24);

  // The drawer steps through what is on screen, unless the selected camera is
  // filtered out of it (the scope changed while it was open).
  const drawerList = visible.some((row) => row.camera === selectedCamera)
    ? visible
    : rows;
  const drawerIndex = drawerList.findIndex(
    (row) => row.camera === selectedCamera,
  );
  const drawerRow = drawerIndex >= 0 ? drawerList[drawerIndex] : undefined;

  if (!config) {
    return configError ? (
      <ErrorState error={configError} onRetry={wrapAsync(() => mutate())} />
    ) : (
      <Skeleton className="mt-4 h-64" />
    );
  }

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const step = (delta: number) => {
    if (drawerList.length === 0) return;
    const next =
      drawerList[(drawerIndex + delta + drawerList.length) % drawerList.length];
    if (next) updateView({ health: next.camera });
  };

  return (
    <div className="scrollbar-container mt-4 flex flex-col gap-3.5 overflow-y-auto">
      {Boolean(configError) && (
        <ErrorState
          compact
          error={configError}
          onRetry={wrapAsync(() => mutate())}
        />
      )}
      {Boolean(history.error) && (
        <ErrorState compact error={history.error} onRetry={history.refresh} />
      )}

      {/* The range lives with the page title (CameraHealthToolbar), so this
          row only carries what narrows the table under it. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ToggleGroup
          type="single"
          size="sm"
          value={scope}
          aria-label={t("cameraHealth.scope.label")}
          className={cn(
            "gap-1 *:rounded-md *:px-3",
            phoneTouch && "*:min-h-11",
          )}
          onValueChange={(value) => {
            if (value === "attention" || value === "all") {
              updateView({ scope: value === "all" ? null : value });
            }
          }}
        >
          <ToggleGroupItem
            value="attention"
            className={scope === "attention" ? "" : "text-muted-foreground"}
          >
            {t("cameraHealth.scope.attention", { value: attentionCount })}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="all"
            className={scope === "all" ? "" : "text-muted-foreground"}
          >
            {t("cameraHealth.scope.all", { value: rows.length })}
          </ToggleGroupItem>
        </ToggleGroup>

        <span className="text-sm text-muted-foreground">
          {t("cameraHealth.hint")}
        </span>
      </div>

      {!fresh && (
        <output className="text-sm text-warning">
          {t("models.readiness.stale", { ns: "views/system" })}
        </output>
      )}

      <HealthSummary
        rows={rows}
        range={range}
        hasHistory={hasHistory}
        attention={attentionCount}
      />

      {visible.length === 0 ? (
        <p
          className="rounded-lg border border-secondary p-6 text-center text-sm text-muted-foreground"
          data-testid="camera-health-empty"
        >
          {rows.length === 0
            ? t("cameraHealth.table.noCameras")
            : t("cameraHealth.table.empty")}
        </p>
      ) : (
        <HealthTable
          rows={visible}
          range={range}
          start={start}
          cellSeconds={cellSeconds}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          onOpen={(camera) => updateView({ health: camera })}
        />
      )}

      <CameraHealthDrawer
        row={drawerRow}
        index={drawerIndex}
        total={drawerList.length}
        range={range}
        start={start}
        end={end}
        cellSeconds={cellSeconds}
        onClose={() => updateView({ health: null })}
        onStep={step}
      />
    </div>
  );
}

type HealthSummaryProps = {
  rows: readonly HealthRow[];
  range: HistoryRange;
  hasHistory: boolean;
  attention: number;
};

/** The one line that says whether anything needs a look. */
function HealthSummary({
  rows,
  range,
  hasHistory,
  attention,
}: Readonly<HealthSummaryProps>) {
  const { t } = useTranslation(["fork"]);

  const fragment = (row: HealthRow): string => {
    if (row.state === "offline") {
      return t("cameraHealth.summary.unreachable", { camera: row.label });
    }
    if (row.issues.offlineSeconds > 0) {
      return t("cameraHealth.summary.down", {
        camera: row.label,
        count: minutesOf(row.issues.offlineSeconds),
      });
    }
    if (row.issues.restarts > 0) {
      return t("cameraHealth.summary.restarted", {
        camera: row.label,
        count: row.issues.restarts,
      });
    }
    if (row.issues.stalls > 0) {
      return t("cameraHealth.summary.stalled", {
        camera: row.label,
        count: row.issues.stalls,
      });
    }
    return t("cameraHealth.summary.degraded", { camera: row.label });
  };

  const clean = rows.filter(ranClean).length;
  const withHistory = rows.filter((row) => row.series !== undefined);
  const fleet =
    withHistory.length > 0
      ? withHistory.reduce((sum, row) => sum + row.uptime, 0) /
        withHistory.length
      : 100;

  const details = sortRows(
    rows.filter((row) => needsAttention(row) || hasIssues(row.issues)),
    "state",
    "asc",
  )
    .slice(0, SUMMARY_CAMERAS)
    .map(fragment);
  details.push(
    hasHistory
      ? t("cameraHealth.summary.fleet", { value: formatPercent(fleet) })
      : t("cameraHealth.summary.waiting"),
  );

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-secondary bg-background_alt p-4 text-sm"
      data-testid="camera-health-summary"
      data-attention={attention}
    >
      <LuHeartPulse className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-primary">
        {t("cameraHealth.summary.lead", {
          clean,
          count: rows.length,
          range: t(`cameraHealth.rangeLong.${range}`),
        })}
      </span>
      <span className="text-muted-foreground">{details.join(" · ")}</span>
    </div>
  );
}

type HealthTableProps = {
  rows: readonly HealthRow[];
  range: HistoryRange;
  start: number;
  cellSeconds: number;
  sortKey: SortKey;
  sortDir: SortDirection;
  onSort: (key: SortKey) => void;
  onOpen: (camera: string) => void;
};

function HealthTable({
  rows,
  range,
  start,
  cellSeconds,
  sortKey,
  sortDir,
  onSort,
  onOpen,
}: Readonly<HealthTableProps>) {
  const { t } = useTranslation(["fork"]);
  const rangeLabel = t(`cameraHealth.range.${range}`);

  const columns: Array<{
    key: SortKey | null;
    label: string;
    className: string;
  }> = [
    {
      key: "name",
      label: t("cameraHealth.table.camera"),
      className: "w-[22%]",
    },
    {
      key: "state",
      label: t("cameraHealth.table.state"),
      className: "w-[12%]",
    },
    {
      key: "rate",
      label: t("cameraHealth.table.rate", { range: rangeLabel }),
      className: "hidden w-[20%] sm:table-cell",
    },
    {
      key: "uptime",
      label: t("cameraHealth.table.uptime"),
      className: "w-[18%]",
    },
    {
      key: "share",
      label: t("cameraHealth.table.detector"),
      className: "hidden w-[8%] xl:table-cell",
    },
    {
      key: null,
      label: t("cameraHealth.table.issues", { range: rangeLabel }),
      className: "hidden lg:table-cell",
    },
    { key: null, label: "", className: "w-9" },
  ];

  const sortedAriaDirection = sortDir === "asc" ? "ascending" : "descending";
  return (
    <table
      className="w-full border-collapse text-sm"
      data-testid="camera-health-table"
    >
      <thead>
        <tr className="border-b border-secondary text-left text-xs uppercase tracking-wide text-muted-foreground">
          {columns.map(({ key, label, className }) => (
            <th
              key={label || "open"}
              scope="col"
              className={cn("px-3 pb-2 font-medium", className)}
              aria-sort={
                key === null || key !== sortKey
                  ? undefined
                  : sortedAriaDirection
              }
            >
              {key === null ? (
                label
              ) : (
                // The column the table is sorted by reads brighter than the
                // rest, so the order on screen is attributable without
                // hunting for the arrow.
                <button
                  type="button"
                  className={cn(
                    "flex items-center gap-1.5 uppercase tracking-wide hover:text-primary",
                    key === sortKey && "text-primary",
                  )}
                  aria-label={t("cameraHealth.table.sort", { column: label })}
                  onClick={() => onSort(key)}
                >
                  {label}
                  {key === sortKey &&
                    (sortDir === "asc" ? (
                      <LuArrowUp className="size-3" />
                    ) : (
                      <LuArrowDown className="size-3" />
                    ))}
                </button>
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <HealthTableRow
            key={row.camera}
            row={row}
            start={start}
            cellSeconds={cellSeconds}
            onOpen={onOpen}
          />
        ))}
      </tbody>
    </table>
  );
}

type HealthTableRowProps = {
  row: HealthRow;
  start: number;
  cellSeconds: number;
  onOpen: (camera: string) => void;
};

function HealthTableRow({
  row,
  start,
  cellSeconds,
  onOpen,
}: Readonly<HealthTableRowProps>) {
  const { t } = useTranslation(["fork"]);
  const spark = sparklinePoints(row.series, start, cellSeconds);
  const state = row.state;

  const issues: string[] = [];
  if (row.issues.outages > 0) {
    issues.push(
      t("cameraHealth.issues.outages", { count: row.issues.outages }),
    );
  }
  if (row.issues.restarts > 0) {
    issues.push(
      t("cameraHealth.issues.restarts", { count: row.issues.restarts }),
    );
  }
  if (row.issues.stalls > 0) {
    issues.push(t("cameraHealth.issues.stalls", { count: row.issues.stalls }));
  }
  if (row.issues.reconnects > 0) {
    issues.push(
      t("cameraHealth.issues.reconnects", { count: row.issues.reconnects }),
    );
  }

  const down =
    row.issues.offlineSeconds > 0
      ? t("cameraHealth.minutes", {
          count: minutesOf(row.issues.offlineSeconds),
        })
      : t("cameraHealth.table.clean");

  return (
    <tr
      className="relative border-b border-secondary/60 transition-colors hover:bg-secondary/40"
      data-testid={`camera-health-${row.camera}`}
      data-state={state}
    >
      <td className="px-3 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full bg-current",
              STATE_DOT[state],
            )}
          />
          <button
            type="button"
            aria-label={t("cameraHealth.table.open", { camera: row.label })}
            className={cn(
              "min-w-0 truncate text-left font-medium smart-capitalize",
              "after:absolute after:inset-0 after:content-['']",
              phoneTouch && "min-h-11",
            )}
            onClick={() => onOpen(row.camera)}
          >
            {row.label}
          </button>
        </div>
      </td>
      <td className="px-3 py-3">
        <Badge variant="outline" className={STATE_BADGE[state]}>
          {t(`cameraHealth.state.${state}`)}
        </Badge>
      </td>
      <td className="hidden px-3 py-3 sm:table-cell">
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0 tabular-nums">
            {row.expectedFps
              ? `${formatFps(row.fps)} / ${row.expectedFps}`
              : formatFps(row.fps)}
          </span>
          <Sparkline
            className="hidden h-5 w-[120px] shrink-0 md:block"
            values={spark.values}
            times={spark.times}
            reference={row.expectedFps}
            label={t("cameraHealth.sparklineLabel", { camera: row.label })}
            strokeClassName={STATE_DOT[state]}
          />
        </div>
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span
            className={cn(
              "tabular-nums",
              row.series === undefined || row.uptime >= 100
                ? "text-muted-foreground"
                : "text-orange-400",
            )}
          >
            {row.series === undefined
              ? t("cameraHealth.table.noHistory")
              : t("cameraHealth.percent", {
                  value: formatPercent(row.uptime),
                })}
          </span>
          {row.series !== undefined && (
            <span
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs",
                row.issues.offlineSeconds > 0
                  ? "bg-orange-400/15 text-orange-400"
                  : "bg-secondary text-muted-foreground",
              )}
              data-testid="camera-health-downtime"
            >
              <LuActivity className="size-2.5" />
              {down}
            </span>
          )}
        </div>
      </td>
      <td className="hidden px-3 py-3 tabular-nums text-muted-foreground xl:table-cell">
        {row.share === undefined
          ? "-"
          : t("cameraHealth.percent", { value: String(row.share) })}
      </td>
      <td
        className="hidden max-w-0 truncate px-3 py-3 text-muted-foreground lg:table-cell"
        data-testid="camera-health-issues"
      >
        {issues.length > 0 ? issues.join(", ") : t("cameraHealth.table.clean")}
      </td>
      <td className="px-3 py-3 text-right">
        <LuChevronRight className="inline size-4 text-muted-foreground" />
      </td>
    </tr>
  );
}
