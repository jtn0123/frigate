/**
 * Fork (UI107, UI124): placeholder for a System metric card with nothing to draw.
 *
 * A card whose series had no samples rendered only its title, a 60 px strip
 * that jumped to full height when the first stats sample arrived. This takes
 * the height of one bar graph (its 16 px label row and 120 px chart) and says
 * why the card is empty.
 *
 * UI124: the sentence was the same in every empty card, so a detector that
 * had gone silent and one that had simply not reported yet looked identical,
 * and neither said how long the wait had been. The card now names the series
 * it is waiting on and, once stats have arrived without it, says how stale it
 * is and reads as a warning rather than a neutral placeholder.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IoIosWarning } from "react-icons/io";
import { cn } from "@/lib/utils";

/** A series with no sample is stale once stats have been flowing this long. */
export const STALE_AFTER_MS = 30_000;

type MetricEmptyStateProps = {
  className?: string;
  /** Names of the series this card would draw, when they are known. */
  subjects?: readonly string[];
  /** Epoch ms of the last stats payload, from the System page. */
  lastUpdated?: number;
};

/** True when no series has a sample to draw. */
// eslint-disable-next-line react-refresh/only-export-components
export function hasNoSamples(
  series: readonly { data: readonly unknown[] }[] | undefined,
): boolean {
  return !series?.some((entry) => entry.data.length > 0);
}

/** The series that have a sample; one without any has nothing to draw. */
// eslint-disable-next-line react-refresh/only-export-components
export function withSamples<T extends { data: readonly unknown[] }>(
  series: readonly T[],
): T[] {
  return series.filter((entry) => entry.data.length > 0);
}

/** Whole seconds since `since`, never negative. */
// eslint-disable-next-line react-refresh/only-export-components
export function secondsSince(since: number, now: number): number {
  return Math.max(0, Math.round((now - since) / 1000));
}

export default function MetricEmptyState({
  className,
  subjects,
  lastUpdated,
}: Readonly<MetricEmptyStateProps>) {
  const { t } = useTranslation(["fork"]);

  // one tick a second, only while the card is empty
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const waited =
    lastUpdated === undefined
      ? undefined
      : secondsSince(lastUpdated * 1000, now);
  // stats are arriving and this series still has nothing: it is the series
  // that is quiet, not the connection
  const stale = waited !== undefined && waited * 1000 >= STALE_AFTER_MS;
  const subject = subjects?.length ? subjects.join(", ") : undefined;

  return (
    <output
      data-testid="metric-empty-state"
      data-stale={stale ? "true" : undefined}
      className={cn(
        "flex h-[136px] w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed px-4 text-center text-sm",
        stale
          ? "border-danger/50 text-danger"
          : "border-secondary-highlight text-secondary-foreground",
        className,
      )}
    >
      <span className="flex items-center gap-1.5">
        {stale && <IoIosWarning className="size-4 shrink-0" aria-hidden />}
        {subject
          ? t(
              stale ? "systemMetrics.staleNamed" : "systemMetrics.waitingNamed",
              {
                subject,
              },
            )
          : t(stale ? "systemMetrics.stale" : "systemMetrics.waiting")}
      </span>
      {waited !== undefined && (
        <span className="text-xs opacity-80">
          {t("systemMetrics.lastUpdate", { count: waited })}
        </span>
      )}
    </output>
  );
}
