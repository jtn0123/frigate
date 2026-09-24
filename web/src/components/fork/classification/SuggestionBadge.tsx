/**
 * The suggested class on a train grid card, with one-click confirm (fork I41).
 *
 * Sits over the card's top left corner. Confirm files every image of the
 * event under the suggested class through the fork's confirm endpoint, which
 * also records which suggestion led to the label. Editing stays on the
 * card's existing class picker.
 */

import { useCallback, useState } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { HiSparkles } from "react-icons/hi";
import { LuCheck, LuCircleHelp } from "react-icons/lu";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  confirmBody,
  percent,
  type EventSuggestion,
} from "@/lib/fork/classification-suggestions";

type SuggestionBadgeProps = {
  modelName: string;
  eventId: string;
  files: string[];
  entry: EventSuggestion | undefined;
  onRefresh: () => void;
};

export default function SuggestionBadge({
  modelName,
  eventId,
  files,
  entry,
  onRefresh,
}: Readonly<SuggestionBadgeProps>) {
  const { t } = useTranslation(["fork"]);
  const [pending, setPending] = useState(false);

  const suggestion = entry?.suggestion ?? null;

  const confirm = useCallback(async () => {
    if (!suggestion || pending) {
      return;
    }
    setPending(true);
    try {
      await axios.post(
        `classification/${modelName}/suggestions/confirm`,
        confirmBody(eventId, files, suggestion),
      );
      toast.success(
        t("classificationSuggestions.confirmed", {
          category: suggestion.category,
          count: files.length,
        }),
        { position: "top-center" },
      );
      onRefresh();
    } catch {
      toast.error(t("classificationSuggestions.confirmFailed"), {
        position: "top-center",
      });
    } finally {
      setPending(false);
    }
  }, [suggestion, pending, modelName, eventId, files, onRefresh, t]);

  if (!entry) {
    return null;
  }

  if (!suggestion) {
    if (!entry.conflict) {
      return null;
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-testid="suggestion-conflict"
            className="absolute left-1 top-1 z-10 flex size-6 items-center justify-center rounded-md bg-black/60 text-white/80"
          >
            <LuCircleHelp className="size-4" />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {t("classificationSuggestions.conflict", {
            text: entry.text?.category ?? "",
            jev: entry.jev?.category ?? "",
          })}
        </TooltipContent>
      </Tooltip>
    );
  }

  const score = percent(suggestion);
  const sourceLabel = t(
    suggestion.source === "jev"
      ? "classificationSuggestions.fromJev"
      : "classificationSuggestions.fromDescription",
  );

  return (
    <div
      data-testid="suggestion-badge"
      className="absolute left-1 top-1 z-10 flex max-w-[calc(100%-3rem)] items-center gap-1 rounded-md bg-black/60 py-0.5 pl-1.5 pr-0.5 text-xs text-white"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex min-w-0 items-center gap-1">
            <HiSparkles className="size-3 shrink-0 text-selected" />
            <span className="truncate smart-capitalize">
              {suggestion.category}
            </span>
            {score != null && (
              <span className="shrink-0 text-white/70 [@container(max-width:10rem)]:hidden">
                {score}%
              </span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          <div>{sourceLabel}</div>
          {suggestion.evidence && (
            <div className="text-secondary-foreground">
              {suggestion.evidence}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      <Button
        size="xs"
        variant="select"
        aria-label={t("classificationSuggestions.confirm", {
          category: suggestion.category,
        })}
        className={cn("size-5 rounded", pending && "opacity-60")}
        disabled={pending}
        onClick={(e) => {
          e.stopPropagation();
          void confirm();
        }}
      >
        <LuCheck className="size-3.5" />
      </Button>
    </div>
  );
}
