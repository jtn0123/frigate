import { useCallback } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { mutate } from "swr";
import {
  reportKey,
  type UndoSuggestionBody,
} from "@/lib/fork/classification-suggestions";

/**
 * Moves an accepted group's images back to the train grid (fork I41).
 *
 * The toast after a single accept offers this as its Undo action. The
 * files are the dataset names the confirm call returned. Resolves to
 * whether they moved back; the grid and the report refresh either way.
 */
export function useUndoSuggestion(modelName: string, onRefresh: () => unknown) {
  const { t } = useTranslation(["fork"]);

  return useCallback(
    async (body: UndoSuggestionBody): Promise<boolean> => {
      let restored: unknown;
      try {
        const response = await axios.post<{ restored?: unknown }>(
          `classification/${modelName}/suggestions/undo`,
          body,
        );
        restored = response.data.restored;
      } catch {
        toast.error(t("classificationSuggestions.undoFailed"), {
          position: "top-center",
        });
        await Promise.all([onRefresh(), mutate(reportKey(modelName))]);
        return false;
      }
      toast.success(
        t("classificationSuggestions.undone", {
          count: restoredCount(restored, body.files.length),
        }),
        { position: "top-center" },
      );
      await Promise.all([onRefresh(), mutate(reportKey(modelName))]);
      return true;
    },
    [modelName, onRefresh, t],
  );
}

/** The server returns the restored names or their count; either reads. */
function restoredCount(restored: unknown, fallback: number): number {
  if (Array.isArray(restored)) {
    return restored.length;
  }
  return typeof restored === "number" ? restored : fallback;
}
