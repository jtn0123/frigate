/**
 * One row above the train grid (fork I41, I42, I49, I50, I54): how many
 * photos on the page have a guess, a switch that lists the least sure
 * events first and a button that accepts every guess after one
 * confirmation. Notes on tiny photos and lopsided classes sit inline on
 * wide screens and in a "More" menu on phones, where the row stays one
 * line. The kept rate, Jev and the model check live on the Stats page. A
 * hint above the row explains the pills until it is dismissed, and a Train
 * now bar shows once enough new photos are in the dataset.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { HiSparkles } from "react-icons/hi";
import { LuArrowDownUp, LuEllipsisVertical, LuTag, LuX } from "react-icons/lu";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useConfirmSuggestion } from "@/hooks/fork/use-confirm-suggestion";
import { useSuggestionHint } from "@/hooks/fork/use-suggestion-hint";
import { useSuggestionReport } from "@/hooks/fork/use-suggestion-report";
import type {
  ClassificationSuggestionsResponse,
  DraftToFile,
} from "@/lib/fork/classification-suggestions";
import {
  answeredImageCount,
  draftImageCount,
  draftsPerClass,
  draftsToFile,
  draftsToRun,
  reportKey,
  tinyImageCount,
} from "@/lib/fork/classification-suggestions";

/** New photos in the dataset before the bar suggests training (fork I54). */
const TRAIN_NUDGE_AT = 10;

type SuggestionStatusBarProps = {
  modelName: string;
  data: ClassificationSuggestionsResponse | undefined;
  groups: Record<string, { filename: string }[]>;
  onRefresh: () => unknown;
  /** Whether the grid lists the least sure events first (fork I49). */
  unsureFirst?: boolean;
  onUnsureFirst?: (value: boolean) => void;
  /** Told while Accept all runs, so the page can hold the single accepts. */
  onFiling?: (filing: boolean) => void;
  /** Upstream's train action; unset while the model cannot train (I54). */
  onTrain?: () => void;
  className?: string;
};

export default function SuggestionStatusBar({
  modelName,
  data,
  groups,
  onRefresh,
  unsureFirst = false,
  onUnsureFirst,
  onFiling,
  onTrain,
  className,
}: Readonly<SuggestionStatusBarProps>) {
  const { t } = useTranslation(["fork", "common"]);
  const { data: report } = useSuggestionReport(modelName);
  const [hintSeen, dismissHint, hintLoaded] = useSuggestionHint();
  const confirmSuggestion = useConfirmSuggestion(modelName, onRefresh);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [skipTiny, setSkipTiny] = useState(true);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [trainedAt, setTrainedAt] = useState<number | null>(null);

  // Once an answer has arrived, keep showing it while the next one loads
  // (or while the page has no ids left to ask about), so the row does not
  // blink away after each accept.
  const [lastData, setLastData] = useState(data);
  if (data && data !== lastData) {
    setLastData(data);
  }
  const shown = data ?? (lastData?.model === modelName ? lastData : undefined);

  const drafts = useMemo(
    () => draftsToFile(shown?.suggestions, groups),
    [shown, groups],
  );
  const run = useMemo(
    () => draftsToRun(drafts, shown?.too_small, skipTiny),
    [drafts, shown, skipTiny],
  );
  const tinyImages = useMemo(
    () => tinyImageCount(drafts, shown?.too_small),
    [drafts, shown],
  );
  const images = useMemo(
    () => answeredImageCount(shown?.suggestions, groups),
    [shown, groups],
  );

  // Stop Accept all when the page goes away, and stay quiet about it.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A function, so each check reads the ref again after an await.
  const gone = useCallback(() => !alive.current, []);

  const fileAll = useCallback(
    async (batch: DraftToFile[]) => {
      onFiling?.(true);
      setProgress({ done: 0, total: batch.length });
      let filed = 0;
      for (const [index, draft] of batch.entries()) {
        if (gone()) {
          break;
        }
        // One at a time: each call moves files on disk.
        const ok = await confirmSuggestion(
          draft.eventId,
          draft.files,
          draft.suggestion,
          undefined,
          true,
        );
        filed += ok ? 1 : 0;
        if (!gone()) {
          setProgress({ done: index + 1, total: batch.length });
        }
      }
      if (gone()) {
        onFiling?.(false);
        return;
      }
      if (filed === 0) {
        toast.error(
          t("classificationSuggestions.fileAllFailed", {
            count: batch.length,
          }),
          { position: "top-center" },
        );
      } else {
        toast[filed === batch.length ? "success" : "warning"](
          t("classificationSuggestions.fileAllDone", {
            count: filed,
            total: batch.length,
          }),
          { position: "top-center" },
        );
      }
      await Promise.all([onRefresh(), mutate(reportKey(modelName))]);
      if (!gone()) {
        setProgress(null);
      }
      onFiling?.(false);
    },
    [confirmSuggestion, gone, onFiling, onRefresh, modelName, t],
  );

  if (!shown) {
    return null;
  }

  const reportPath = `/classification/suggestions/${encodeURIComponent(modelName)}`;
  const lopsided = report?.dataset?.lopsided ? report.dataset : undefined;
  const lopsidedText = lopsided
    ? t("classificationSuggestions.lopsided", {
        largest: lopsided.largest ?? "",
        smallest: lopsided.smallest ?? "",
        ratio: lopsided.ratio ?? 0,
      })
    : undefined;
  const tinyText =
    tinyImages > 0
      ? t("classificationSuggestions.tinyPhotos", { count: tinyImages })
      : undefined;
  const omittedText =
    (shown.omitted ?? 0) > 0
      ? t("classificationSuggestions.omitted", {
          shown: images.answered,
          total: images.total,
        })
      : undefined;
  const newImages = report?.training?.new_images ?? 0;
  const showTrain =
    onTrain != null && newImages >= TRAIN_NUDGE_AT && newImages !== trainedAt;
  const tinyDrafts =
    drafts.length - draftsToRun(drafts, shown.too_small, true).length;
  const hasMenu =
    onUnsureFirst != null ||
    report != null ||
    tinyText != null ||
    lopsidedText != null ||
    omittedText != null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {hintLoaded && !hintSeen && (
        <div
          data-testid="suggestion-hint"
          className="mx-1 flex flex-col gap-2 rounded-lg bg-secondary p-3 text-sm text-primary sm:flex-row sm:items-start"
        >
          <span className="flex flex-1 items-start gap-2">
            <LuTag className="mt-0.5 size-4 shrink-0 text-selected" />
            <span>{t("classificationSuggestions.hint")}</span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 self-end px-2 text-xs sm:self-auto"
            onClick={dismissHint}
          >
            {t("classificationSuggestions.hintDismiss")}
            <LuX className="size-3.5" />
          </Button>
        </div>
      )}
      <div
        data-testid="suggestion-status"
        className="flex items-center gap-x-3 gap-y-1 px-1 text-xs text-secondary-foreground md:flex-wrap"
      >
        <span
          data-testid="suggestion-headline"
          className="flex min-w-0 items-center gap-1 font-medium text-primary"
        >
          <LuTag className="size-3 shrink-0 text-selected" />
          <span className="truncate">
            {t("classificationSuggestions.guessCount", {
              count: draftImageCount(drafts),
              total: images.total,
            })}
          </span>
        </span>
        {tinyText && (
          <span data-testid="suggestion-small" className="hidden md:inline">
            {tinyText}
          </span>
        )}
        {omittedText && (
          <span data-testid="suggestion-omitted" className="hidden md:inline">
            {omittedText}
          </span>
        )}
        {lopsidedText && (
          <Link
            to={reportPath}
            className="hidden text-warning md:inline"
            data-testid="suggestion-lopsided"
          >
            {lopsidedText}
          </Link>
        )}
        {report && (
          <Link
            to={reportPath}
            className="hidden text-selected md:inline"
            data-testid="suggestion-report-link"
          >
            {t("classificationSuggestions.reportLink")}
          </Link>
        )}
        <span className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {onUnsureFirst && (
            <Button
              size="sm"
              variant={unsureFirst ? "select" : "outline"}
              className="hidden h-7 gap-1 px-2 text-xs md:flex"
              aria-pressed={unsureFirst}
              data-testid="train-order-toggle"
              onClick={() => onUnsureFirst(!unsureFirst)}
            >
              <LuArrowDownUp className="size-3.5" />
              {t("classificationSuggestions.unsureFirst")}
            </Button>
          )}
          {drafts.length > 0 && (
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="select"
                  className="h-7 px-2.5 text-xs"
                  data-testid="file-all"
                  disabled={progress != null}
                >
                  {progress
                    ? t("classificationSuggestions.fileAllProgress", progress)
                    : t("classificationSuggestions.fileAll", {
                        count: run.length,
                      })}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent data-testid="file-all-dialog">
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("classificationSuggestions.fileAllTitle", {
                      count: run.length,
                    })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("classificationSuggestions.fileAllDescription")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                {run.length > 0 && (
                  <div
                    data-testid="file-all-preview"
                    className="text-sm text-primary smart-capitalize"
                  >
                    {draftsPerClass(run)
                      .map(([category, count]) => `${category} ${count}`)
                      .join(", ")}
                  </div>
                )}
                {tinyDrafts > 0 && (
                  <label className="flex items-center gap-2 text-sm text-primary">
                    <Checkbox
                      data-testid="file-all-skip-tiny"
                      checked={skipTiny}
                      onCheckedChange={(checked) =>
                        setSkipTiny(checked === true)
                      }
                    />
                    {t("classificationSuggestions.skipTiny", {
                      count: tinyDrafts,
                    })}
                  </label>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel>
                    {t("button.cancel", { ns: "common" })}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    disabled={run.length === 0}
                    onClick={() => void fileAll(run)}
                  >
                    {t("classificationSuggestions.fileAll", {
                      count: run.length,
                    })}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {hasMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 md:hidden"
                  aria-label={t("classificationSuggestions.more")}
                  data-testid="suggestion-more"
                >
                  <LuEllipsisVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                collisionPadding={8}
                className="max-w-72"
              >
                {onUnsureFirst && (
                  <DropdownMenuCheckboxItem
                    data-testid="train-order-menu"
                    checked={unsureFirst}
                    onCheckedChange={(checked) =>
                      onUnsureFirst(checked === true)
                    }
                  >
                    {t("classificationSuggestions.unsureFirst")}
                  </DropdownMenuCheckboxItem>
                )}
                {report && (
                  <DropdownMenuItem asChild>
                    <Link to={reportPath}>
                      {t("classificationSuggestions.reportLink")}
                    </Link>
                  </DropdownMenuItem>
                )}
                {[tinyText, omittedText, lopsidedText]
                  .filter((text): text is string => text != null)
                  .map((text) => (
                    <DropdownMenuItem
                      key={text}
                      disabled
                      className="text-xs text-secondary-foreground"
                    >
                      {text}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </div>
      {showTrain && (
        <Button
          size="sm"
          variant="select"
          className="mx-1 gap-2"
          data-testid="suggestion-train-now"
          onClick={() => {
            setTrainedAt(newImages);
            onTrain();
          }}
        >
          <HiSparkles className="size-4" />
          {t("classificationSuggestions.trainNow", { count: newImages })}
        </Button>
      )}
    </div>
  );
}
