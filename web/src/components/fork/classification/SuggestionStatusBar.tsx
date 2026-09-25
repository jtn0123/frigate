/**
 * One line above the train grid: how many cards have a draft, whether Jev
 * is answering and how much of today's budget is used, how often past
 * drafts were kept, and a button that files every draft on the page after
 * one confirmation (fork I41, I42).
 */

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { HiSparkles } from "react-icons/hi";
import { toast } from "sonner";
import { mutate } from "swr";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConfirmSuggestion } from "@/hooks/fork/use-confirm-suggestion";
import { useSuggestionReport } from "@/hooks/fork/use-suggestion-report";
import type { ClassificationSuggestionsResponse } from "@/lib/fork/classification-suggestions";
import {
  draftsToFile,
  reportKey,
  smallDraftCount,
} from "@/lib/fork/classification-suggestions";

type SuggestionStatusBarProps = {
  modelName: string;
  data: ClassificationSuggestionsResponse | undefined;
  groups: Record<string, { filename: string }[]>;
  onRefresh: () => void;
  /** Whether the grid lists the least sure events first (fork I49). */
  unsureFirst?: boolean;
  onUnsureFirst?: (value: boolean) => void;
};

export default function SuggestionStatusBar({
  modelName,
  data,
  groups,
  onRefresh,
  unsureFirst = false,
  onUnsureFirst,
}: Readonly<SuggestionStatusBarProps>) {
  const { t } = useTranslation(["fork", "common"]);
  const { data: report } = useSuggestionReport(modelName);
  const confirmSuggestion = useConfirmSuggestion(modelName, onRefresh);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const drafts = useMemo(
    () => draftsToFile(data?.suggestions, groups),
    [data, groups],
  );
  const small = useMemo(
    () => smallDraftCount(drafts, data?.too_small),
    [drafts, data],
  );

  const fileAll = useCallback(async () => {
    setPending(true);
    let filed = 0;
    for (const draft of drafts) {
      // One at a time: each call moves files on disk.
      if (
        await confirmSuggestion(
          draft.eventId,
          draft.files,
          draft.suggestion,
          undefined,
          true,
        )
      ) {
        filed += 1;
      }
    }
    setPending(false);
    toast[filed === drafts.length ? "success" : "warning"](
      t("classificationSuggestions.fileAllDone", {
        count: filed,
        total: drafts.length,
      }),
      { position: "top-center" },
    );
    onRefresh();
    void mutate(reportKey(modelName));
  }, [drafts, confirmSuggestion, onRefresh, modelName, t]);

  if (!data) {
    return null;
  }

  const jev = data.jev;
  let jevText: string;
  if (jev.enabled && jev.configured) {
    jevText = t("classificationSuggestions.jevUsage", {
      used: jev.used_today,
      limit: jev.daily_request_limit,
    });
  } else if (jev.enabled) {
    jevText = t("classificationSuggestions.jevNoKey");
  } else {
    jevText = t("classificationSuggestions.jevOff");
  }

  return (
    <div
      data-testid="suggestion-status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-1 text-xs text-secondary-foreground"
    >
      <span className="flex items-center gap-1">
        <HiSparkles className="size-3 text-selected" />
        {t("classificationSuggestions.draftsOnPage", {
          count: drafts.length,
        })}
      </span>
      {small > 0 && (
        <span data-testid="suggestion-small" className="text-warning">
          {t("classificationSuggestions.smallDrafts", { count: small })}
        </span>
      )}
      <span>{jevText}</span>
      {report && report.total > 0 && report.rate != null && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span data-testid="suggestion-kept" className="cursor-default">
              {t("classificationSuggestions.kept", {
                rate: Math.round(report.rate * 100),
                count: report.total,
              })}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">
            {Object.entries(report.classes).map(([category, stats]) => (
              <div key={category} className="smart-capitalize">
                {t("classificationSuggestions.keptClass", {
                  category,
                  rate: Math.round((stats.rate ?? 0) * 100),
                  count: stats.total,
                })}
                {Object.keys(stats.corrected_to).length > 0 && (
                  <span className="text-secondary-foreground">
                    {" "}
                    {t("classificationSuggestions.correctedTo", {
                      list: Object.entries(stats.corrected_to)
                        .sort((a, b) => b[1] - a[1])
                        .map(([other, n]) => `${other} ${n}`)
                        .join(", "),
                    })}
                  </span>
                )}
              </div>
            ))}
          </TooltipContent>
        </Tooltip>
      )}
      {report?.model_check &&
        report.model_check.total > 0 &&
        report.model_check.rate != null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-testid="suggestion-model-check"
                className="cursor-default"
              >
                {t("classificationSuggestions.modelAgrees", {
                  rate: Math.round(report.model_check.rate * 100),
                  count: report.model_check.total,
                })}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-80">
              {Object.entries(report.model_check.classes).map(
                ([category, stats]) => (
                  <div key={category} className="smart-capitalize">
                    {t("classificationSuggestions.modelClass", {
                      category,
                      rate: Math.round((stats.rate ?? 0) * 100),
                      count: stats.total,
                    })}
                    {Object.keys(stats.corrected_to).length > 0 && (
                      <span className="text-secondary-foreground">
                        {" "}
                        {t("classificationSuggestions.descriptionSaid", {
                          list: Object.entries(stats.corrected_to)
                            .sort((a, b) => b[1] - a[1])
                            .map(([other, n]) => `${other} ${n}`)
                            .join(", "),
                        })}
                      </span>
                    )}
                  </div>
                ),
              )}
            </TooltipContent>
          </Tooltip>
        )}
      {report && (report.total > 0 || (report.model_check?.total ?? 0) > 0) && (
        <Link
          to={`/classification/suggestions/${encodeURIComponent(modelName)}`}
          className="text-selected"
          data-testid="suggestion-report-link"
        >
          {t("classificationSuggestions.reportLink")}
        </Link>
      )}
      {report && (report.auto_filed ?? 0) > 0 && (
        <span data-testid="suggestion-auto-filed">
          {t("classificationSuggestions.autoFiled", {
            count: report.auto_filed ?? 0,
          })}
        </span>
      )}
      {report?.dataset?.lopsided && (
        <Link
          to={`/classification/suggestions/${encodeURIComponent(modelName)}`}
          className="text-warning"
          data-testid="suggestion-lopsided"
        >
          {t("classificationSuggestions.lopsided", {
            largest: report.dataset.largest ?? "",
            smallest: report.dataset.smallest ?? "",
            ratio: report.dataset.ratio ?? 0,
          })}
        </Link>
      )}
      {onUnsureFirst && (
        <Button
          size="sm"
          variant={unsureFirst ? "select" : "outline"}
          className="h-6 px-2 text-xs"
          aria-pressed={unsureFirst}
          data-testid="train-order-toggle"
          onClick={() => onUnsureFirst(!unsureFirst)}
        >
          {t("classificationSuggestions.unsureFirst")}
        </Button>
      )}
      {drafts.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          disabled={pending}
          onClick={() => setConfirmOpen(true)}
        >
          {t("classificationSuggestions.fileAll", { count: drafts.length })}
        </Button>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="file-all-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("classificationSuggestions.fileAllTitle", {
                count: drafts.length,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("classificationSuggestions.fileAllDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("button.cancel", { ns: "common" })}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                void fileAll();
              }}
            >
              {t("classificationSuggestions.fileAll", {
                count: drafts.length,
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
