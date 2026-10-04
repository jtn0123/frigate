/**
 * Fork (UI146): live telemetry at the top of the System page's General tab.
 *
 * Three cards, as UniFi Protect shows them: the bitrate coming in through
 * go2rtc, how many people are watching, and each detector's latency. Below
 * them, the same figures per camera. The bitrate has no stored history, so
 * its sparklines appear after the second read and fill over the window while
 * the tab is open. On a phone the three figures are one compact row without
 * sparklines, so the graphs below stay within reach.
 */

import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronDown, LuInfo } from "react-icons/lu";

import Sparkline from "@/components/fork/Sparkline";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/fork/use-viewport";
import { resolveCameraName } from "@/hooks/use-camera-friendly-name";
import { usePersistence } from "@/hooks/use-persistence";
import {
  TELEMETRY_REFRESH_MS,
  useLiveTelemetry,
  type LiveTelemetry,
  type ReadStatus,
} from "@/hooks/fork/use-live-telemetry";
import { formatDetectorName } from "@/lib/fork/detector-name";
import { receiveRate } from "@/lib/fork/go2rtc-state";
import {
  TELEMETRY_WINDOW_SECONDS,
  viewerKinds,
  worstLatencyLevel,
  type CameraTelemetry,
  type ConsumerKind,
  type LatencyLevel,
  type SparkSeries,
} from "@/lib/fork/live-telemetry";
import { phoneTouch } from "@/lib/fork/phone";
import { cn } from "@/lib/utils";
import { InferenceThreshold } from "@/types/graph";

/** Whether the per-camera table is open, remembered per browser. */
export const PER_CAMERA_KEY = "live-telemetry-per-camera";

const LEVEL_TEXT: Record<LatencyLevel, string> = {
  ok: "text-success",
  warning: "text-orange-400",
  error: "text-danger",
};

const LEVEL_CARD: Record<LatencyLevel, string> = {
  ok: "border-transparent",
  warning: "border-orange-400/50 bg-orange-400/10",
  error: "border-danger/50 bg-danger/10",
};

/**
 * The Live dot follows the go2rtc read: it only pulses while figures arrive.
 * Paused takes the view's warning orange; the theme's warning color is a
 * banner background, nearly black on a light page and lost on a dark one.
 */
const DOT: Record<ReadStatus, string> = {
  ready: "bg-success",
  loading: "bg-muted-foreground",
  unavailable: "bg-orange-400",
};

const STATUS_BADGE: Record<"partial" | "notMeasured", string> = {
  partial: "border-orange-400/40 bg-orange-400/10 text-orange-400",
  notMeasured: "border-transparent bg-secondary text-muted-foreground",
};

function formatRate(
  t: TFunction,
  bytesPerSecond: number | null,
): string | undefined {
  const rate = receiveRate(bytesPerSecond);
  return rate
    ? t(`cameraHealth.source.rate.${rate.unit}`, { value: rate.value })
    : undefined;
}

function kindLabel(t: TFunction, kind: ConsumerKind, streams: number): string {
  switch (kind) {
    case "webrtc":
      return t("liveTelemetry.kinds.webrtc", { ns: "fork", count: streams });
    case "mse":
      return t("liveTelemetry.kinds.mse", { ns: "fork", count: streams });
    case "hls":
      return t("liveTelemetry.kinds.hls", { ns: "fork", count: streams });
    case "mjpeg":
      return t("liveTelemetry.kinds.mjpeg", { ns: "fork", count: streams });
    case "rtsp":
      return t("liveTelemetry.kinds.rtsp", { ns: "fork", count: streams });
    case "other":
      return t("liveTelemetry.kinds.other", { ns: "fork", count: streams });
  }
}

function dotLabel(t: TFunction, status: ReadStatus): string {
  switch (status) {
    case "ready":
      return t("liveTelemetry.status.ready", { ns: "fork" });
    case "loading":
      return t("liveTelemetry.status.loading", { ns: "fork" });
    case "unavailable":
      return t("liveTelemetry.status.unavailable", { ns: "fork" });
  }
}

/** Green and pulsing while go2rtc answers, so a dead feed does not look live. */
function LiveDot({ status }: Readonly<{ status: ReadStatus }>) {
  const { t } = useTranslation(["fork"]);
  return (
    <span
      className="relative flex size-2"
      role="img"
      aria-label={dotLabel(t, status)}
      data-testid="live-dot"
      data-state={status}
    >
      {status === "ready" && (
        <span
          className="absolute inline-flex size-full rounded-full bg-success opacity-60 motion-safe:animate-ping"
          data-testid="live-dot-ping"
        />
      )}
      <span
        className={cn("relative inline-flex size-2 rounded-full", DOT[status])}
      />
    </span>
  );
}

/** A sparkline once it has a line to draw, instead of a blank band. */
function CardSparkline({
  series,
  label,
}: Readonly<{ series: SparkSeries; label: string }>) {
  if (series.values.length < 2) return null;
  return (
    <Sparkline
      className="h-10"
      values={series.values}
      times={series.times}
      reference={undefined}
      label={label}
      strokeClassName="text-selected"
    />
  );
}

type CardProps = {
  title: string;
  testId: string;
  className?: string;
  action?: ReactNode;
  children: ReactNode;
};

/** The look of the graph cards below, so the row reads as part of the tab. */
function Card({
  title,
  testId,
  className,
  action,
  children,
}: Readonly<CardProps>) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border border-transparent bg-background_alt p-2.5 md:rounded-2xl",
        className,
      )}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-2">
        <div>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

function BigValue({
  status,
  children,
  className,
  compact = false,
}: Readonly<{
  status: ReadStatus;
  children: ReactNode;
  className?: string;
  compact?: boolean;
}>) {
  if (status === "loading") {
    return <Skeleton className={compact ? "h-7 w-16" : "h-8 w-28"} />;
  }
  return (
    <div
      className={cn(
        "font-semibold tabular-nums",
        compact ? "truncate text-lg leading-7" : "text-2xl leading-8",
        status === "unavailable" && "text-muted-foreground",
        className,
      )}
      data-testid="live-value"
    >
      {status === "unavailable" ? "-" : children}
    </div>
  );
}

function Footnote({
  children,
  testId,
}: Readonly<{ children: ReactNode; testId?: string }>) {
  return (
    <p className="text-xs text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}

/** go2rtc answered, but no camera reads through it: there is nothing to see. */
function nothingMeasured({ totals, go2rtcStatus }: LiveTelemetry) {
  return (
    go2rtcStatus === "ready" &&
    totals.cameras > 0 &&
    totals.measuredCameras === 0
  );
}

/** The bitrate figure's state: a dash, not "Measuring", when no rate can arrive. */
function bitrateStatus(telemetry: LiveTelemetry): ReadStatus {
  return nothingMeasured(telemetry) ? "unavailable" : telemetry.go2rtcStatus;
}

/** How many cameras the bitrate covers, or why it covers none. */
function bitrateNote(t: TFunction, telemetry: LiveTelemetry): string {
  const { totals, go2rtcStatus } = telemetry;
  if (go2rtcStatus === "unavailable") {
    return t("liveTelemetry.unavailable", { ns: "fork" });
  }
  if (totals.cameras === 0) {
    return t("liveTelemetry.bitrate.noCameras", { ns: "fork" });
  }
  return t("liveTelemetry.bitrate.cameras", {
    ns: "fork",
    measured: totals.measuredCameras,
    count: totals.cameras,
  });
}

/** The consumer list's state; with go2rtc down, the last list is stale. */
function viewerReadStatus(telemetry: LiveTelemetry): ReadStatus {
  return telemetry.go2rtcStatus === "unavailable"
    ? "unavailable"
    : telemetry.viewersStatus;
}

/** The viewer figure's state: a dash when no camera goes through go2rtc. */
function viewerValueStatus(telemetry: LiveTelemetry): ReadStatus {
  const status = viewerReadStatus(telemetry);
  return status === "ready" && nothingMeasured(telemetry)
    ? "unavailable"
    : status;
}

function BitrateCard({ telemetry }: Readonly<{ telemetry: LiveTelemetry }>) {
  const { t } = useTranslation(["fork"]);
  const rate = formatRate(t, telemetry.totals.bytesPerSecond);

  return (
    <Card title={t("liveTelemetry.bitrate.title")} testId="live-bitrate">
      <BigValue status={bitrateStatus(telemetry)}>
        {rate ?? t("liveTelemetry.measuring")}
      </BigValue>
      <CardSparkline
        series={telemetry.totalSeries}
        label={t("liveTelemetry.bitrate.sparkline")}
      />
      <Footnote testId="live-bitrate-note">
        {bitrateNote(t, telemetry)}
      </Footnote>
    </Card>
  );
}

/** The button that explains who the viewer count includes. */
function ViewersInfo({ compact = false }: Readonly<{ compact?: boolean }>) {
  const { t } = useTranslation(["fork"]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center justify-center rounded-full text-muted-foreground hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-selected",
            // a 44 px target on phones without making the header taller
            phoneTouch && "min-h-11 min-w-11",
            phoneTouch && (compact ? "-m-3.5" : "-my-2.5 -mr-2.5"),
          )}
          aria-label={t("liveTelemetry.viewers.howCounted")}
        >
          <LuInfo className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm" data-testid="live-viewers-info">
        <p className="font-medium">{t("liveTelemetry.viewers.howCounted")}</p>
        {/* three short paragraphs: who counts, who does not, the limits */}
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p>{t("liveTelemetry.viewers.explanation")}</p>
          <p>{t("liveTelemetry.viewers.explanationNotCounted")}</p>
          <p>{t("liveTelemetry.viewers.explanationLimits")}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ViewersCard({ telemetry }: Readonly<{ telemetry: LiveTelemetry }>) {
  const { t } = useTranslation(["fork"]);
  const { totals, viewerSeries } = telemetry;
  const status = viewerReadStatus(telemetry);
  const counts = totals.consumers;
  const kinds = viewerKinds(counts);
  const unseen = status === "ready" && nothingMeasured(telemetry);

  // the number is people; the line below says how many streams they play
  let breakdown: string;
  if (status === "unavailable") {
    breakdown = t("liveTelemetry.viewers.unavailable");
  } else if (unseen) {
    breakdown = t("liveTelemetry.viewers.unseen");
  } else if (!counts || kinds.length === 0) {
    breakdown = t("liveTelemetry.viewers.none");
  } else {
    breakdown = t("liveTelemetry.viewers.streams", {
      count: counts.streams,
      kinds: kinds
        .map(({ kind, count }) => kindLabel(t, kind, count))
        .join(", "),
    });
  }

  return (
    <Card
      title={t("liveTelemetry.viewers.title")}
      testId="live-viewers"
      action={<ViewersInfo />}
    >
      <BigValue status={viewerValueStatus(telemetry)}>
        {counts?.viewers ?? 0}
      </BigValue>
      <CardSparkline
        series={viewerSeries}
        label={t("liveTelemetry.viewers.sparkline")}
      />
      <Footnote testId="live-viewers-breakdown">{breakdown}</Footnote>
      {status === "ready" && counts && counts.internal > 0 && (
        <Footnote testId="live-viewers-internal">
          {t("liveTelemetry.viewers.internal", { count: counts.internal })}
        </Footnote>
      )}
    </Card>
  );
}

function LatencyCard({ telemetry }: Readonly<{ telemetry: LiveTelemetry }>) {
  const { t } = useTranslation(["fork"]);
  const { detectors, latencyStatus } = telemetry;
  const worst = worstLatencyLevel(detectors);

  let body: ReactNode;
  if (latencyStatus === "loading") {
    body = <Skeleton className="h-8 w-28" />;
  } else if (detectors.length === 0) {
    body = (
      <Footnote>
        {latencyStatus === "unavailable"
          ? t("liveTelemetry.latency.unavailable")
          : t("liveTelemetry.latency.waiting")}
      </Footnote>
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {detectors.map((detector) => (
          <div
            key={detector.name}
            data-testid={`live-latency-${detector.name}`}
            data-level={detector.level}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm text-muted-foreground">
                {formatDetectorName(detector.name)}
              </span>
              <span
                className={cn(
                  "text-xl font-semibold tabular-nums",
                  LEVEL_TEXT[detector.level],
                )}
              >
                {t("liveTelemetry.latency.ms", {
                  value: detector.latest.toFixed(1),
                })}
              </span>
            </div>
            <Sparkline
              className="h-6"
              values={detector.series.values}
              times={detector.series.times}
              // the threshold line only once it matters: drawn while all is
              // well it would squash a 10 ms line against the bottom
              reference={
                detector.level === "ok" ? undefined : InferenceThreshold.warning
              }
              label={t("liveTelemetry.latency.sparkline", {
                detector: formatDetectorName(detector.name),
              })}
              strokeClassName={LEVEL_TEXT[detector.level]}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <Card
      title={t("liveTelemetry.latency.title")}
      testId="live-latency"
      className={LEVEL_CARD[worst]}
    >
      {body}
      <Footnote testId="live-latency-note">
        {worst === "ok"
          ? t("liveTelemetry.latency.threshold", {
              warning: InferenceThreshold.warning,
            })
          : t("liveTelemetry.latency.slow", {
              warning: InferenceThreshold.warning,
            })}
      </Footnote>
    </Card>
  );
}

function CompactFigure({
  title,
  testId,
  action,
  level,
  children,
}: Readonly<{
  title: string;
  testId: string;
  action?: ReactNode;
  level?: LatencyLevel;
  children: ReactNode;
}>) {
  return (
    <div className="min-w-0" data-testid={testId} data-level={level}>
      <div className="flex items-center gap-1">
        <div className="truncate text-xs text-muted-foreground">{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * The phone layout: the three figures in one row, with no sparklines, so the
 * section stays a few lines tall and the graphs below are within reach.
 */
function CompactFigures({ telemetry }: Readonly<{ telemetry: LiveTelemetry }>) {
  const { t } = useTranslation(["fork"]);
  const { totals, detectors, latencyStatus } = telemetry;
  const rate = formatRate(t, totals.bytesPerSecond);
  // the slowest detector, as the card's tint follows the worst one
  const slowest = detectors.reduce<(typeof detectors)[number] | undefined>(
    (worst, detector) =>
      !worst || detector.latest > worst.latest ? detector : worst,
    undefined,
  );

  return (
    <div
      className="mt-3 flex flex-col gap-2 rounded-lg bg-background_alt p-2.5"
      data-testid="live-compact"
    >
      <div className="grid grid-cols-3 gap-2">
        <CompactFigure
          title={t("liveTelemetry.bitrate.title")}
          testId="live-bitrate"
        >
          <BigValue status={bitrateStatus(telemetry)} compact>
            {rate ?? t("liveTelemetry.measuring")}
          </BigValue>
        </CompactFigure>
        <CompactFigure
          title={t("liveTelemetry.viewers.title")}
          testId="live-viewers"
          action={<ViewersInfo compact />}
        >
          <BigValue status={viewerValueStatus(telemetry)} compact>
            {totals.consumers?.viewers ?? 0}
          </BigValue>
        </CompactFigure>
        <CompactFigure
          title={t("liveTelemetry.latency.title")}
          testId="live-latency"
          {...(slowest ? { level: slowest.level } : {})}
        >
          <BigValue
            status={
              latencyStatus === "ready" && !slowest
                ? "unavailable"
                : latencyStatus
            }
            {...(slowest ? { className: LEVEL_TEXT[slowest.level] } : {})}
            compact
          >
            {slowest &&
              t("liveTelemetry.latency.ms", {
                value: slowest.latest.toFixed(1),
              })}
          </BigValue>
        </CompactFigure>
      </div>
      <Footnote testId="live-compact-note">
        {bitrateNote(t, telemetry)}
      </Footnote>
    </div>
  );
}

function RateCell({ row }: Readonly<{ row: CameraTelemetry }>) {
  const { t } = useTranslation(["fork"]);
  const rate = formatRate(t, row.bytesPerSecond);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="tabular-nums">
        {rate ?? (
          <span className="text-muted-foreground">
            {t("liveTelemetry.measuring")}
          </span>
        )}
      </span>
      {row.status === "partial" && (
        <Badge
          variant="outline"
          className={STATUS_BADGE.partial}
          title={t("liveTelemetry.table.partialHint")}
        >
          {t("liveTelemetry.table.partial")}
        </Badge>
      )}
    </div>
  );
}

/**
 * The go2rtc streams a camera reads, unless that is only its namesake
 * stream, which would repeat the camera name under itself.
 */
function streamNamesNote(row: CameraTelemetry): string | undefined {
  const namesake = row.streams.length === 1 && row.streams[0] === row.camera;
  return row.streams.length === 0 || namesake
    ? undefined
    : row.streams.join(" · ");
}

function CameraRow({
  row,
  telemetry,
}: Readonly<{ row: CameraTelemetry; telemetry: LiveTelemetry }>) {
  const { t } = useTranslation(["fork"]);
  const label = resolveCameraName(telemetry.config, row.camera);
  const series = telemetry.cameraSeries(row.camera);
  const measured = row.status !== "notMeasured";
  const streamNames = streamNamesNote(row);

  return (
    <tr
      className="border-b border-secondary/60"
      data-testid={`live-camera-${row.camera}`}
      data-status={row.status}
    >
      <td className="px-2 py-2.5 md:px-3">
        <div className="truncate font-medium smart-capitalize">{label}</div>
        {streamNames && (
          <div
            className="hidden truncate text-xs text-muted-foreground sm:block"
            data-testid="live-camera-stream-names"
          >
            {streamNames}
          </div>
        )}
      </td>
      <td className="hidden px-3 py-2.5 text-muted-foreground sm:table-cell">
        {row.codecs.length > 0 ? row.codecs.join(" · ") : "-"}
      </td>
      {measured ? (
        <>
          <td className="px-2 py-2.5 md:px-3">
            <RateCell row={row} />
          </td>
          <td className="px-2 py-2.5 md:px-3">
            <Sparkline
              className="h-6 w-full min-w-[64px] max-w-[160px]"
              values={series.values}
              times={series.times}
              reference={undefined}
              label={t("liveTelemetry.table.sparkline", { camera: label })}
              strokeClassName="text-selected"
            />
          </td>
        </>
      ) : (
        <td className="px-2 py-2.5 md:px-3" colSpan={2}>
          <Badge
            variant="outline"
            className={STATUS_BADGE.notMeasured}
            title={t("liveTelemetry.table.notMeasuredHint")}
          >
            {t("liveTelemetry.table.notMeasured")}
          </Badge>
        </td>
      )}
      <td className="px-2 py-2.5 text-right md:px-3">
        <div
          className="font-medium tabular-nums"
          data-testid="live-camera-streams"
        >
          {row.consumers ? row.consumers.streams : "-"}
        </div>
        {row.consumers && row.consumers.internal > 0 && (
          <div className="hidden whitespace-nowrap text-xs text-muted-foreground sm:block">
            {t("liveTelemetry.table.internal", {
              count: row.consumers.internal,
            })}
          </div>
        )}
      </td>
    </tr>
  );
}

function CameraTable({ telemetry }: Readonly<{ telemetry: LiveTelemetry }>) {
  const { t } = useTranslation(["fork"]);
  const { rows, go2rtcStatus } = telemetry;

  if (go2rtcStatus === "unavailable") {
    return (
      <p
        className="px-3 py-2 text-sm text-muted-foreground"
        data-testid="live-camera-unavailable"
      >
        {t("liveTelemetry.unavailable")}
      </p>
    );
  }

  const notMeasured = rows.some((row) => row.status === "notMeasured");
  const partial = rows.some((row) => row.status === "partial");

  return (
    <div className="rounded-lg bg-background_alt p-1 md:rounded-2xl md:p-2">
      <table
        className="w-full table-fixed border-collapse text-sm"
        data-testid="live-camera-table"
      >
        <thead>
          <tr className="border-b border-secondary text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="w-[34%] px-2 py-2 font-medium md:px-3">
              {t("liveTelemetry.table.camera")}
            </th>
            <th
              scope="col"
              className="hidden w-[16%] px-3 py-2 font-medium sm:table-cell"
            >
              {t("liveTelemetry.table.codec")}
            </th>
            <th scope="col" className="w-[24%] px-2 py-2 font-medium md:px-3">
              {t("liveTelemetry.table.bitrate")}
            </th>
            <th scope="col" className="px-2 py-2 font-medium md:px-3">
              {t("liveTelemetry.table.trend", {
                minutes: TELEMETRY_WINDOW_SECONDS / 60,
              })}
            </th>
            <th
              scope="col"
              className="w-[18%] px-2 py-2 text-right font-medium md:w-[14%] md:px-3"
            >
              {t("liveTelemetry.table.streams")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <CameraRow key={row.camera} row={row} telemetry={telemetry} />
          ))}
        </tbody>
      </table>
      {(notMeasured || partial) && (
        <div className="space-y-1 px-2 pb-1 pt-2 md:px-3">
          {notMeasured && (
            <Footnote testId="live-not-measured-note">
              {t("liveTelemetry.table.notMeasuredHint")}
            </Footnote>
          )}
          {partial && (
            <Footnote testId="live-partial-note">
              {t("liveTelemetry.table.partialHint")}
            </Footnote>
          )}
        </div>
      )}
    </div>
  );
}

type LiveTelemetryViewProps = {
  isActive: boolean;
};

export default function LiveTelemetryView({
  isActive,
}: Readonly<LiveTelemetryViewProps>) {
  const { t } = useTranslation(["fork"]);
  const telemetry = useLiveTelemetry(isActive);
  const isPhone = useIsMobile();
  // open on a desktop, closed on a phone where it would push the graphs
  // down; a choice the user made wins either way
  const [stored, setShowCameras] = usePersistence<boolean>(
    PER_CAMERA_KEY,
    !isPhone,
  );
  const showCameras = stored ?? !isPhone;

  return (
    <section
      className="mb-6 flex shrink-0 flex-col"
      aria-labelledby="live-telemetry-title"
      data-testid="live-telemetry"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <LiveDot status={telemetry.go2rtcStatus} />
        <h2
          id="live-telemetry-title"
          className="text-sm font-medium text-muted-foreground"
        >
          {t("liveTelemetry.title")}
        </h2>
        <span className="text-xs text-muted-foreground">
          {t("liveTelemetry.cadence", {
            seconds: TELEMETRY_REFRESH_MS / 1000,
            minutes: TELEMETRY_WINDOW_SECONDS / 60,
          })}
        </span>
      </div>
      {isPhone ? (
        <CompactFigures telemetry={telemetry} />
      ) : (
        <div className="mt-4 grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
          <BitrateCard telemetry={telemetry} />
          <ViewersCard telemetry={telemetry} />
          <LatencyCard telemetry={telemetry} />
        </div>
      )}
      <button
        type="button"
        className={cn(
          "mt-3 flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-primary",
          phoneTouch && "min-h-11",
        )}
        aria-expanded={showCameras}
        aria-controls="live-telemetry-cameras"
        onClick={() => setShowCameras(!showCameras)}
        data-testid="live-camera-toggle"
      >
        <LuChevronDown
          className={cn(
            "size-4 transition-transform",
            !showCameras && "-rotate-90",
          )}
          aria-hidden
        />
        {t("liveTelemetry.table.toggle", { count: telemetry.rows.length })}
      </button>
      {showCameras && (
        <div id="live-telemetry-cameras" className="mt-2">
          <CameraTable telemetry={telemetry} />
        </div>
      )}
    </section>
  );
}
