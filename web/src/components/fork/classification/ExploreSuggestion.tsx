/**
 * The draft class for an event in the Explore detail dialog (fork I46).
 *
 * One line per custom model that classifies the event's label: what the
 * description supports, where it came from, what the trained model said,
 * and a File button that files the event's waiting train images without a
 * trip to the training page. Admins only, since filing is.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { HiSparkles } from "react-icons/hi";
import { LuCheck, LuTriangleAlert } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { useConfirmSuggestion } from "@/hooks/fork/use-confirm-suggestion";
import { useEventSuggestions } from "@/hooks/fork/use-event-suggestions";
import { useIsAdmin } from "@/hooks/use-is-admin";
import {
  percent,
  allTooSmall,
  type EventModelSuggestion,
} from "@/lib/fork/classification-suggestions";
import { cn } from "@/lib/utils";

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
          onFiled={() => void mutate()}
        />
      ))}
    </div>
  );
}

type ModelRowProps = {
  eventId: string;
  row: EventModelSuggestion;
  onFiled: () => void;
};

function ModelRow({ eventId, row, onFiled }: Readonly<ModelRowProps>) {
  const { t } = useTranslation(["fork"]);
  const [pending, setPending] = useState(false);
  const confirmSuggestion = useConfirmSuggestion(row.model, onFiled);
  const suggestion = row.suggestion.suggestion;
  const files = row.training_files;
  const tiny = allTooSmall(files, row.too_small);

  const file = useCallback(async () => {
    if (!suggestion || pending) {
      return;
    }
    setPending(true);
    try {
      await confirmSuggestion(eventId, files, suggestion);
    } finally {
      setPending(false);
    }
  }, [suggestion, pending, confirmSuggestion, eventId, files]);

  const disagrees =
    row.model_said != null &&
    suggestion != null &&
    row.model_said.toLowerCase() !== suggestion.category.toLowerCase();

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {row.filed ? (
        <span className="flex items-center gap-1 text-secondary-foreground">
          <LuCheck className="size-3.5 text-success" />
          {t("classificationSuggestions.filedAs", {
            model: row.model,
            category: row.filed.category,
          })}
          {row.filed.auto && ` ${t("classificationSuggestions.filedAuto")}`}
        </span>
      ) : (
        suggestion && (
          <>
            <span className="flex items-center gap-1">
              <HiSparkles className="size-3.5 text-selected" />
              {t("classificationSuggestions.suggested", {
                model: row.model,
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
            {files.length > 0 ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  disabled={pending}
                  onClick={() => void file()}
                >
                  {t("classificationSuggestions.file")}
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
              <span className="text-xs text-secondary-foreground">
                {t("classificationSuggestions.noTrainImages")}
              </span>
            )}
          </>
        )
      )}
      {row.model_said && (
        <span
          data-testid="explore-model-said"
          className={cn(
            "flex items-center gap-1 text-xs",
            disagrees ? "text-warning" : "text-secondary-foreground",
          )}
        >
          {disagrees && <LuTriangleAlert className="size-3.5" />}
          {t("classificationSuggestions.modelSaid", {
            category: row.model_said,
          })}
        </span>
      )}
    </div>
  );
}
