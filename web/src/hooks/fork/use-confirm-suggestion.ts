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
      suggestion: Suggestion | null,
      category?: string,
      bulk = false,
    ): Promise<boolean> => {
      const body = confirmBody(eventId, files, suggestion, category, bulk);
      const refresh = () =>
        Promise.all([onRefresh(), mutate(reportKey(modelName))]);
      let moved: string[];
      try {
        moved = await postConfirm(modelName, body);
      } catch (error) {
        return handleConfirmError(error, { bulk, category, t, refresh });
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
          ...undoAction(t, undo, eventId, body.category, moved),
        },
      );
      await refresh();
      return true;
    },
    [modelName, onRefresh, t, undo],
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];
type Undo = ReturnType<typeof useUndoSuggestion>;

/** Post the confirm body and return the dataset names of the moved images. */
async function postConfirm(
  modelName: string,
  body: ReturnType<typeof confirmBody>,
): Promise<string[]> {
  const response = await axios.post<{ moved?: unknown }>(
    `classification/${modelName}/suggestions/confirm`,
    body,
  );
  if (!Array.isArray(response.data.moved)) {
    return [];
  }
  return response.data.moved.filter(
    (name): name is string => typeof name === "string",
  );
}

type ErrorContext = {
  bulk: boolean;
  category: string | undefined;
  t: Translate;
  refresh: () => Promise<unknown>;
};

/**
 * Turn a failed confirm into the user-facing outcome: "already accepted"
 * counts as done, anything else shows why. Bulk calls stay silent.
 */
async function handleConfirmError(
  error: unknown,
  { bulk, category, t, refresh }: ErrorContext,
): Promise<boolean> {
  const response = axios.isAxiosError(error) ? error.response : undefined;
  const already = isAlreadyAccepted(response?.status, response?.data);
  if (bulk) {
    return already;
  }
  if (already) {
    toast.info(t("classificationSuggestions.alreadyAccepted"), {
      position: "top-center",
    });
  } else {
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
  }
  // The card may be stale (filed in another tab); show what is true.
  await refresh();
  return already;
}

/** The toast's Undo button, only when something was moved. */
function undoAction(
  t: Translate,
  undo: Undo,
  eventId: string,
  category: string,
  moved: string[],
) {
  if (moved.length === 0) {
    return {};
  }
  return {
    action: {
      label: t("classificationSuggestions.undo"),
      onClick: () => void undo({ event_id: eventId, category, files: moved }),
    },
  };
}
