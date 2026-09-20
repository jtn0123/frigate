/**
 * Fork: the Review grid's "mark as reviewed" bar (UI116).
 *
 * Upstream centered a lone button in the middle of the grid, far from the
 * items it acts on and with no hint of how many that is. This is a bar that
 * sits under the last row, says how many items are unreviewed, and carries
 * the count in the button label.
 */

import { useTranslation } from "react-i18next";
import { LuCheck } from "react-icons/lu";
import { Button } from "@/components/ui/button";

type MarkReviewedBarProps = {
  /** How many items the button will mark. */
  count: number;
  onMarkReviewed: () => void;
};

export default function MarkReviewedBar({
  count,
  onMarkReviewed,
}: Readonly<MarkReviewedBarProps>) {
  const { t } = useTranslation(["fork"]);
  const label = t("markReviewed.action", { count });

  return (
    <div
      data-testid="mark-reviewed-bar"
      className="col-span-full flex flex-wrap items-center justify-start gap-3 rounded-lg border border-secondary-foreground/10 bg-background_alt p-3"
    >
      <span className="text-sm text-secondary-foreground">
        {t("markReviewed.summary", { count })}
      </span>
      <Button
        aria-label={label}
        className="min-h-[44px] text-balance"
        variant="select"
        onClick={onMarkReviewed}
      >
        <LuCheck className="mr-2 size-4" aria-hidden />
        {label}
      </Button>
    </div>
  );
}
