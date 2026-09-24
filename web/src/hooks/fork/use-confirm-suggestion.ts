import { useCallback } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { mutate } from "swr";
import {
  confirmBody,
  reportKey,
  type Suggestion,
} from "@/lib/fork/classification-suggestions";

/**
 * Files images of an event through the fork's confirm endpoint (fork I41).
 *
 * Shared by the badge (accept the draft on every image), the class picker
 * (override the draft on one image) and the file-all action, so every path
 * records the suggestion beside the label. Resolves to whether the files
 * were moved. Quiet calls skip the toast and refresh so a bulk caller can
 * report once at the end.
 */
export function useConfirmSuggestion(modelName: string, onRefresh: () => void) {
  const { t } = useTranslation(["fork"]);

  return useCallback(
    async (
      eventId: string,
      files: string[],
      suggestion: Suggestion,
      category?: string,
      quiet = false,
    ): Promise<boolean> => {
      const body = confirmBody(eventId, files, suggestion, category);
      try {
        await axios.post(
          `classification/${modelName}/suggestions/confirm`,
          body,
        );
      } catch {
        if (!quiet) {
          toast.error(t("classificationSuggestions.confirmFailed"), {
            position: "top-center",
          });
        }
        return false;
      }
      if (quiet) {
        return true;
      }
      toast.success(
        t("classificationSuggestions.confirmed", {
          category: body.category,
          count: files.length,
        }),
        { position: "top-center" },
      );
      onRefresh();
      void mutate(reportKey(modelName));
      return true;
    },
    [modelName, onRefresh, t],
  );
}
