/**
 * The draft class for an event in the Explore detail dialog (fork I46).
 *
 * One line per custom model that classifies the event's label: the model's
 * guess from the description, how sure it is, what the trained model
 * thinks, and an Add button that files the event's waiting train images
 * without a trip to the training page. Admins only, since filing is.
 */

import { useCallback, useState } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { HiSparkles } from "react-icons/hi";
import { LuCheck } from "react-icons/lu";
import { toast } from "sonner";
import { mutate as mutateKey } from "swr";
import { Button } from "@/components/ui/button";
import { useEventSuggestions } from "@/hooks/fork/use-event-suggestions";
import { useIsAdmin } from "@/hooks/use-is-admin";
import {
  allTooSmall,
  confirmBody,
  percent,
  reportKey,
  type EventModelSuggestion,
  modelLabel,
} from "@/lib/fork/classification-suggestions";

/** The confirm endpoint's answer when the group was already moved. */
const ALREADY_ACCEPTED = "already accepted";

type ExploreSuggestionProps = {
  eventId: string;
  hasModels: boolean;
};

export default function ExploreSuggestion({
  eventId,
  hasModels,
}: Readonly<ExploreSuggestionProps>) {
  const isAdmin = useIsAdmin();
  const { data, mutate } = useEventSuggestions(
    hasModels && isAdmin ? eventId : null,
  );
  const refresh = useCallback(() => mutate(), [mutate]);

  const rows = (data?.models ?? []).filter(
    (row) => row.filed || row.suggestion.suggestion,
  );
  if (rows.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="explore-suggestion"
      className="flex flex-col gap-1 text-sm"
    >
      {rows.map((row) => (
        <ModelRow
          key={row.model}
          eventId={eventId}
          row={row}
          refresh={refresh}
        />
      ))}
    </div>
  );
}

type ModelRowProps = {
  eventId: string;
  row: EventModelSuggestion;
  refresh: () => Promise<unknown>;
};

type AddOutcome = "added" | "sorted" | "failed";

function ModelRow({ eventId, row, refresh }: Readonly<ModelRowProps>) {
  const { t } = useTranslation(["fork"]);
  const [pending, setPending] = useState(false);
  const [sorted, setSorted] = useState(false);
  const suggestion = row.suggestion.suggestion;
  const files = row.training_files;
  const tiny = allTooSmall(files, row.too_small);
  const name = modelLabel(row.model);

  const add = useCallback(async () => {
    if (!suggestion || pending) {
      return;
    }
    setPending(true);
    const body = confirmBody(eventId, files, suggestion);
    let outcome: AddOutcome = "added";
    let serverMessage: string | undefined;
    try {
      await axios.post(`classification/${row.model}/suggestions/confirm`, body);
    } catch (error) {
      const response = axios.isAxiosError<{ message?: string } | null>(error)
        ? error.response
        : undefined;
      serverMessage = response?.data?.message;
      outcome =
        response?.status === 404 && serverMessage === ALREADY_ACCEPTED
          ? "sorted"
          : "failed";
    }

    if (outcome === "added") {
      toast.success(
        t("classificationSuggestions.addedToTraining", {
          category: body.category,
          count: files.length,
        }),
        { position: "top-center" },
      );
    } else if (outcome === "sorted") {
      setSorted(true);
    } else {
      toast.error(t("classificationSuggestions.addFailed"), {
        position: "top-center",
        description: serverMessage,
      });
    }
    // Refresh on every outcome, so a stale Add button never stays behind,
    // and keep the button disabled until the new answer is in.
    await Promise.allSettled([refresh(), mutateKey(reportKey(row.model))]);
    setPending(false);
  }, [suggestion, pending, eventId, files, row.model, refresh, t]);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium">{name}</span>
      {row.filed ? (
        <span className="flex items-center gap-1 text-secondary-foreground">
          <LuCheck className="size-3.5 text-success" aria-hidden />
          {t(
            row.filed.auto
              ? "classificationSuggestions.filedAsAuto"
              : "classificationSuggestions.filedAs",
            { category: row.filed.category },
          )}
        </span>
      ) : (
        suggestion && (
          <>
            <span className="flex items-center gap-1">
              <HiSparkles className="size-3.5 text-selected" aria-hidden />
              {t("classificationSuggestions.suggested", {
                category: suggestion.category,
              })}
              <span className="text-secondary-foreground">
                {suggestion.source === "jev" && percent(suggestion) != null
                  ? t("classificationSuggestions.viaJev", {
                      percent: percent(suggestion),
                    })
                  : t("classificationSuggestions.viaText")}
              </span>
            </span>
            {files.length > 0 && !sorted ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  disabled={pending}
                  aria-label={t("classificationSuggestions.fileAria", {
                    category: suggestion.category,
                    model: name,
                  })}
                  onClick={() => void add()}
                >
                  {t("classificationSuggestions.file", {
                    category: suggestion.category,
                  })}
                </Button>
                {tiny && (
                  <span
                    data-testid="suggestion-too-small"
                    className="text-xs text-warning"
                  >
                    {t("classificationSuggestions.tooSmall")}
                  </span>
                )}
              </>
            ) : (
              <span
                data-testid="explore-already-sorted"
                className="text-xs text-secondary-foreground"
              >
                {t("classificationSuggestions.noTrainImages")}
              </span>
            )}
          </>
        )
      )}
      {row.model_said && (
        <span
          data-testid="explore-model-said"
          className="text-xs text-secondary-foreground"
        >
          {t("classificationSuggestions.modelSaid", {
            category: row.model_said,
          })}
        </span>
      )}
    </div>
  );
}
