/**
 * One line above the train grid: how many cards have a draft, whether Jev
 * is answering and how much of today's budget is used, and how often past
 * drafts were kept (fork I41, I42).
 */

import { useTranslation } from "react-i18next";
import { HiSparkles } from "react-icons/hi";
import { useSuggestionReport } from "@/hooks/fork/use-suggestion-report";
import type { ClassificationSuggestionsResponse } from "@/lib/fork/classification-suggestions";
import { draftCount } from "@/lib/fork/classification-suggestions";

type SuggestionStatusBarProps = {
  modelName: string;
  data: ClassificationSuggestionsResponse | undefined;
};

export default function SuggestionStatusBar({
  modelName,
  data,
}: Readonly<SuggestionStatusBarProps>) {
  const { t } = useTranslation(["fork"]);
  const { data: report } = useSuggestionReport(modelName);

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
          count: draftCount(data.suggestions),
        })}
      </span>
      <span>{jevText}</span>
      {report && report.total > 0 && report.rate != null && (
        <span>
          {t("classificationSuggestions.kept", {
            rate: Math.round(report.rate * 100),
            count: report.total,
          })}
        </span>
      )}
    </div>
  );
}
