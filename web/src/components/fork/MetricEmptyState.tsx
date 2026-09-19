/**
 * Fork (UI107): placeholder for a System metric card with nothing to draw.
 *
 * A card whose series had no samples rendered only its title, a 60 px strip
 * that jumped to full height when the first stats sample arrived. This takes
 * the height of one bar graph (its 16 px label row and 120 px chart) and says
 * why the card is empty.
 */

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

type MetricEmptyStateProps = {
  className?: string;
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

export default function MetricEmptyState({
  className,
}: Readonly<MetricEmptyStateProps>) {
  const { t } = useTranslation(["fork"]);

  return (
    <div
      role="status"
      data-testid="metric-empty-state"
      className={cn(
        "flex h-[136px] w-full items-center justify-center rounded-md border border-dashed border-secondary-highlight px-4 text-center text-sm text-secondary-foreground",
        className,
      )}
    >
      {t("systemMetrics.waiting")}
    </div>
  );
}
