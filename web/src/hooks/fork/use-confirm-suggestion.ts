import { useCallback } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  confirmBody,
  type Suggestion,
} from "@/lib/fork/classification-suggestions";

/**
 * Files images of an event through the fork's confirm endpoint (fork I41).
 *
 * Shared by the badge (accept the draft on every image) and the class picker
 * (override the draft on one image), so both paths record the suggestion
 * beside the label. Resolves to whether the files were moved.
 */
export function useConfirmSuggestion(modelName: string, onRefresh: () => void) {
  const { t } = useTranslation(["fork"]);

  return useCallback(
    async (
      eventId: string,
      files: string[],
      suggestion: Suggestion,
      category?: string,
    ): Promise<boolean> => {
      const body = confirmBody(eventId, files, suggestion, category);
      try {
        await axios.post(
          `classification/${modelName}/suggestions/confirm`,
          body,
        );
      } catch {
        toast.error(t("classificationSuggestions.confirmFailed"), {
          position: "top-center",
        });
        return false;
      }
      toast.success(
        t("classificationSuggestions.confirmed", {
          category: body.category,
          count: files.length,
        }),
        { position: "top-center" },
      );
      onRefresh();
      return true;
    },
    [modelName, onRefresh, t],
  );
}
