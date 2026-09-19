/**
 * Fork (UI108): the card for an export that is still being written.
 *
 * An in-progress export used to keep the finished card's look: white title
 * text meant for a thumbnail, drawn over a gray skeleton that never cleared
 * because the thumbnail is not loaded until the export finishes, so the title
 * was nearly invisible. This card uses theme colors, says it is exporting,
 * and shows the progress: a bar with the percent when the export job reports
 * one, an indeterminate bar otherwise.
 */

import * as ProgressPrimitive from "@radix-ui/react-progress";
import { useTranslation } from "react-i18next";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type ExportProgressCardProps = {
  className?: string;
  name: string;
  /** The job's current step, such as "Encoding"; omitted when unknown. */
  stepLabel?: string;
  /** 0 to 100 when the job reports progress; omitted for an indeterminate bar. */
  percent?: number;
};

export default function ExportProgressCard({
  className,
  name,
  stepLabel,
  percent,
}: Readonly<ExportProgressCardProps>) {
  const { t } = useTranslation(["fork"]);
  const rounded =
    percent === undefined
      ? undefined
      : Math.min(100, Math.max(0, Math.round(percent)));
  const detail = [stepLabel, rounded === undefined ? undefined : `${rounded}%`]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      data-testid="export-progress-card"
      aria-busy
      className={cn(
        "relative flex aspect-video cursor-default flex-col justify-between overflow-hidden rounded-lg border border-secondary-highlight bg-secondary p-3 text-primary md:rounded-2xl",
        className,
      )}
    >
      <div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-background px-2 py-0.5 text-xs font-medium text-primary">
          <span
            className="size-1.5 animate-pulse rounded-full bg-selected"
            aria-hidden
          />
          {t("exportProgress.exporting")}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <div className="truncate text-sm font-medium smart-capitalize">
          {name}
        </div>
        {rounded === undefined ? (
          // the Radix root announces a null value as indeterminate
          <ProgressPrimitive.Root
            value={null}
            aria-label={t("exportProgress.label", { name })}
            className="relative h-1.5 w-full overflow-hidden rounded-full bg-primary/15"
          >
            <div className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-selected" />
          </ProgressPrimitive.Root>
        ) : (
          // ui/progress keeps `value` for the bar and does not pass it on,
          // so the root would announce no value
          <Progress
            value={rounded}
            aria-valuenow={rounded}
            aria-label={t("exportProgress.label", { name })}
            className="h-1.5 bg-primary/15 [&>div]:bg-selected"
          />
        )}
        {detail && (
          <div className="truncate text-xs tabular-nums text-secondary-foreground">
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}
