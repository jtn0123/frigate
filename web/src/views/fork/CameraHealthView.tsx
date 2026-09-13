import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { LuSettings } from "react-icons/lu";
import { FaVideo } from "react-icons/fa";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import TimeAgo from "@/components/dynamic/TimeAgo";
import { ConnectionQualityIndicator } from "@/components/camera/ConnectionQualityIndicator";
import { useEnabledState } from "@/api/ws";
import Sparkline from "@/components/fork/Sparkline";
import { useAutoFrigateStats } from "@/hooks/use-stats";
import { useFpsHistory } from "@/hooks/fork/use-stats-history";
import { resolveCameraName } from "@/hooks/use-camera-friendly-name";
import { isReplayCamera } from "@/utils/cameraUtil";
import {
  cameraFpsSeries,
  computeCameraHealth,
  connectionQualityProps,
  detectorShare,
  enabledFromWs,
  newestRestarts,
  restartKindCounts,
  seriesMinutes,
  type CameraHealthState,
} from "@/lib/fork/camera-health";
import { FrigateConfig } from "@/types/frigateConfig";
import { CameraStats, FrigateStats } from "@/types/stats";

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

function formatFps(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) return "-";
  return value.toFixed(1);
}

/**
 * One health card per configured camera, fed by the same stats stream the
 * status bar uses (initial /api/stats, then WebSocket updates).
 */
export default function CameraHealthView() {
  const { t } = useTranslation(["fork", "views/system"]);
  const { data: config } = useSWR<FrigateConfig>("config", {
    revalidateOnFocus: false,
  });
  const stats = useAutoFrigateStats();
  const history = useFpsHistory(stats);
  const [lastTick, setLastTick] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setLastTick(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  // Evaluate against the current clock when new stats arrive between timer ticks.
  const now = Math.max(lastTick, Date.now());
  const fresh =
    stats &&
    Number.isFinite(stats.service.last_updated) &&
    now / 1000 - stats.service.last_updated <= 90 &&
    stats.service.last_updated <= now / 1000 + 5;

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

  if (!config) {
    return null;
  }

  return (
    <div className="scrollbar-container mt-4 flex flex-col gap-3 overflow-y-auto">
      {!fresh && (
        <output className="text-sm text-warning">
          {t("models.readiness.stale", { ns: "views/system" })}
        </output>
      )}
      <div className="text-sm text-muted-foreground">
        {t("cameraHealth.description")}
        {stats?.service.last_updated && (
          <span className="ml-2">
            {t("lastRefreshed", { ns: "views/system" })}
            <TimeAgo time={stats.service.last_updated * 1000} dense />
          </span>
        )}
      </div>
      <div
        className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
        data-testid="camera-health-grid"
      >
        {cameras.map((camera) => (
          <CameraHealthCard
            key={camera.name}
            cameraName={camera.name}
            label={resolveCameraName(config, camera)}
            enabled={camera.enabled}
            stats={fresh ? stats : undefined}
            fpsSeries={cameraFpsSeries(history, camera.name)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Feed restarts in the last 24 h (D11): one collapsed summary line, only when
 * there were any; expanding it lists the latest ones with their reason.
 */
function CameraRestarts({
  cameraStats,
}: Readonly<{
  cameraStats: CameraStats | undefined;
}>) {
  const { t } = useTranslation(["fork"]);
  const count = cameraStats?.restarts_24h ?? 0;
  if (count === 0) {
    return null;
  }

  const kinds = restartKindCounts(cameraStats)
    .map(([kind, n]) =>
      t("cameraHealth.restarts.kindCount", {
        n,
        kind: t(`cameraHealth.restartKind.${kind}`),
      }),
    )
    .join(", ");

  return (
    <details className="text-xs" data-testid="camera-health-restarts">
      <summary className="cursor-pointer text-muted-foreground">
        {t("cameraHealth.restarts.summary", { count, kinds })}
      </summary>
      <ul className="mt-1 flex flex-col gap-1">
        {newestRestarts(cameraStats).map((restart) => (
          <li
            key={`${restart.time}-${restart.role}`}
            className="flex min-w-0 gap-2"
          >
            <span className="shrink-0 tabular-nums text-muted-foreground">
              <TimeAgo time={restart.time * 1000} dense />
            </span>
            <span className="shrink-0">
              {t(`cameraHealth.restartKind.${restart.kind}`)}
              {restart.role !== "detect" && ` · ${restart.role}`}
            </span>
            <span
              className="truncate text-muted-foreground"
              title={restart.message}
            >
              {restart.message}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

type CameraHealthCardProps = {
  cameraName: string;
  label: string;
  enabled: boolean;
  stats: FrigateStats | undefined;
  fpsSeries: { times: number[]; values: number[] };
};

function CameraHealthCard({
  cameraName,
  label,
  enabled,
  stats,
  fpsSeries,
}: Readonly<CameraHealthCardProps>) {
  const { t } = useTranslation(["fork"]);
  const { payload: enabledState } = useEnabledState(cameraName);
  const isEnabled = enabledFromWs(enabledState, enabled);
  const cameraStats = stats?.cameras[cameraName];
  const quality = connectionQualityProps(cameraStats);
  const health = computeCameraHealth(
    { enabled: isEnabled },
    cameraStats,
    stats?.service.uptime,
  );
  const share = detectorShare(stats, cameraName);

  const ffmpegCpu =
    cameraStats?.ffmpeg_cpu ??
    (stats && cameraStats
      ? stats.cpu_usages[String(cameraStats.ffmpeg_pid)]?.cpu
      : undefined);

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
      value: share === undefined ? "-" : `${share}%`,
    },
    {
      key: "reconnects",
      value: String(cameraStats?.reconnects_last_hour ?? "-"),
    },
    { key: "stalls", value: String(cameraStats?.stalls_last_hour ?? "-") },
    {
      key: "ffmpegCpu",
      value: ffmpegCpu && ffmpegCpu !== "0.0" ? `${ffmpegCpu}%` : "-",
    },
  ];

  return (
    <Card
      className="flex flex-col gap-3 p-4"
      data-testid={`camera-health-${cameraName}`}
      data-state={health.state}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium smart-capitalize">
          {label}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {quality && <ConnectionQualityIndicator {...quality} />}
          <Badge variant="outline" className={STATE_BADGE[health.state]}>
            {t(`cameraHealth.state.${health.state}`)}
          </Badge>
        </div>
      </div>
      {health.reasons.length > 0 && (
        <div
          className="text-xs text-muted-foreground"
          data-testid="camera-health-reason"
        >
          {health.reasons
            .map((reason) => t(`cameraHealth.reason.${reason}`))
            .join(", ")}
        </div>
      )}
      {health.notes.length > 0 && (
        <div
          className="text-xs text-muted-foreground"
          data-testid="camera-health-note"
        >
          {health.notes.map((note) => (
            <span key={note}>
              {t(`cameraHealth.note.${note}`)}
              {/* softwareDecoding is the only note, and the one with a time */}
              {!!cameraStats?.hwaccel_fallback_since && (
                <>
                  {" · "}
                  <TimeAgo
                    time={cameraStats.hwaccel_fallback_since * 1000}
                    dense
                  />
                </>
              )}
            </span>
          ))}
        </div>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        {metrics.map((metric) => (
          <div key={metric.key} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">
              {t(`cameraHealth.metric.${metric.key}`)}
            </dt>
            <dd className="font-medium tabular-nums">{metric.value}</dd>
          </div>
        ))}
      </dl>
      <CameraRestarts cameraStats={cameraStats} />
      {/* Pinned to the bottom so charts and buttons line up across a row. */}
      <div className="mt-auto flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Sparkline
            values={fpsSeries.values}
            times={fpsSeries.times}
            reference={cameraStats?.expected_fps}
            label={t("cameraHealth.sparklineLabel", { camera: label })}
            strokeClassName={STATE_DOT[health.state]}
          />
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span data-testid="camera-health-chart-caption">
              {fpsSeries.values.length > 1
                ? t("cameraHealth.chart.caption", {
                    count: seriesMinutes(fpsSeries.times),
                  })
                : t("cameraHealth.chart.waiting")}
            </span>
            {!!cameraStats?.expected_fps && (
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="w-3 border-t border-dashed border-muted-foreground" />
                {t("cameraHealth.chart.target", {
                  fps: cameraStats.expected_fps,
                })}
              </span>
            )}
          </div>
        </div>
        <CameraLinks cameraName={cameraName} />
      </div>
    </Card>
  );
}

function CameraLinks({ cameraName }: Readonly<{ cameraName: string }>) {
  const { t } = useTranslation(["fork"]);
  return (
    <div className="flex items-center gap-2">
      <Button asChild size="sm" variant="outline">
        <Link to={`/#${cameraName}`}>
          <FaVideo className="mr-2 size-3.5" />
          {t("cameraHealth.openLive")}
        </Link>
      </Button>
      <Button asChild size="sm" variant="ghost">
        <Link to={`/settings?page=cameraFfmpeg&camera=${cameraName}`}>
          <LuSettings className="mr-2 size-3.5" />
          {t("cameraHealth.openSettings")}
        </Link>
      </Button>
    </div>
  );
}
