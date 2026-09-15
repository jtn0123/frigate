/**
 * Fork: bulk review actions with undo.
 *
 * `markReviewedWithUndo` performs the same `reviews/viewed` call upstream
 * makes and, when the flag is on, raises a toast whose Undo action reverts
 * the change through the same endpoint within the toast's lifetime.
 */

import axios from "axios";
import i18n from "i18next";
import { toast } from "sonner";
import { isForkEnabled } from "@/fork/flags";
import type { ReviewSegment } from "@/types/review";

export const UNDO_TOAST_MS = 8000;

/**
 * The ids a mark would change. Undo reverts every id it was given, so it
 * must only get these: an item that was already reviewed stays reviewed.
 */
export function changedReviewIds(
  reviews: readonly ReviewSegment[],
  reviewed: boolean,
): string[] {
  return reviews
    .filter((review) => review.has_been_reviewed !== reviewed)
    .map((review) => review.id);
}

export async function markReviewedWithUndo(
  ids: string[],
  reviewed: boolean,
  onReverted: () => void,
) {
  await axios.post("reviews/viewed", { ids, reviewed });

  if (!isForkEnabled("bulkActions") || ids.length === 0) {
    return;
  }

  const message = i18n.t(
    reviewed ? "bulk.markedReviewed" : "bulk.markedUnreviewed",
    { ns: "fork", count: ids.length },
  );

  const revertReviewed = async () => {
    try {
      await axios.post("reviews/viewed", { ids, reviewed: !reviewed });
      toast.success(i18n.t("bulk.undone", { ns: "fork" }), {
        position: "top-center",
      });
    } catch {
      toast.error(i18n.t("bulk.undoFailed", { ns: "fork" }), {
        position: "top-center",
      });
    }
    onReverted();
  };

  toast.success(message, {
    position: "top-center",
    duration: UNDO_TOAST_MS,
    action: {
      label: i18n.t("button.undo", { ns: "common" }),
      onClick: () => {
        void revertReviewed(); // toast action onClick cannot be async
      },
    },
  });
}
