import { useCallback } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { mutate } from "swr";
import {
  confirmBody,
  isAlreadyAccepted,
  reportKey,
  serverMessage,
  type Suggestion,
} from "@/lib/fork/classification-suggestions";
import { useUndoSuggestion } from "@/hooks/fork/use-undo-suggestion";

/**
 * Files images of an event through the fork's confirm endpoint (fork I41).
 *
 * Shared by the badge (accept the draft on every image), the class picker
 * (override the draft on one image) and Accept all, so every path records
 * the suggestion beside the label. Resolves to whether the files are in the
 * dataset now, which a 404 "already accepted" also counts as. A single call
 * resolves only after the grid has refreshed, so the badge stays disabled
 * until its card is gone. Bulk calls send `bulk: true` and skip the toast
 * and the refresh so Accept all can report once at the end.
 */
export function useConfirmSuggestion(
  modelName: string,
  onRefresh: () => unknown,
) {
  const { t } = useTranslation(["fork"]);
  const undo = useUndoSuggestion(modelName, onRefresh);

  return useCallback(
    async (
      eventId: string,
      files: string[],
      suggestion: Suggestion,
      category?: string,
      bulk = false,
    ): Promise<boolean> => {
      const body = confirmBody(eventId, files, suggestion, category, bulk);
      const refresh = () =>
        Promise.all([onRefresh(), mutate(reportKey(modelName))]);
      let moved: string[] = [];
      try {
        const response = await axios.post<{ moved?: unknown }>(
          `classification/${modelName}/suggestions/confirm`,
          body,
        );
        if (Array.isArray(response.data.moved)) {
          moved = response.data.moved.filter(
            (name): name is string => typeof name === "string",
          );
        }
      } catch (error) {
        const response = axios.isAxiosError(error) ? error.response : undefined;
        if (isAlreadyAccepted(response?.status, response?.data)) {
          if (!bulk) {
            toast.info(t("classificationSuggestions.alreadyAccepted"), {
              position: "top-center",
            });
            await refresh();
          }
          return true;
        }
        if (!bulk) {
          const message = serverMessage(response?.data);
          toast.error(
            category == null
              ? t("classificationSuggestions.confirmFailed")
              : t("classificationSuggestions.overrideFailed", { category }),
            {
              position: "top-center",
              ...(message ? { description: message } : {}),
            },
          );
          // The card may be stale (filed in another tab); show what is true.
          await refresh();
        }
        return false;
      }
      if (bulk) {
        return true;
      }
      toast.success(
        t("classificationSuggestions.confirmed", {
          category: body.category,
          count: files.length,
        }),
        {
          position: "top-center",
          ...(moved.length > 0
            ? {
                action: {
                  label: t("classificationSuggestions.undo"),
                  onClick: () =>
                    void undo({
                      event_id: eventId,
                      category: body.category,
                      files: moved,
                    }),
                },
              }
            : {}),
        },
      );
      await refresh();
      return true;
    },
    [modelName, onRefresh, t, undo],
  );
}
