/**
 * Fork (UI116): the System > Enrichments tab with nothing to draw.
 *
 * Stats can arrive with no embeddings section at all, for example when no
 * enrichment has run yet. The tab then showed its heading above an empty
 * grid, which reads as a broken page. This says why it is empty and links to
 * the settings that turn enrichments on.
 */

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { LuSearchCheck } from "react-icons/lu";
import { Button } from "@/components/ui/button";

const ENRICHMENT_SETTINGS_URL = "/settings?page=integrationSemanticSearch";

export default function EnrichmentsEmptyState() {
  const { t } = useTranslation(["fork"]);
  const navigate = useNavigate();

  return (
    <div
      data-testid="enrichments-empty-state"
      className="col-span-full flex flex-col items-center gap-2 rounded-lg border border-dashed border-secondary-highlight p-8 text-center"
    >
      <LuSearchCheck className="size-8 text-secondary-foreground" aria-hidden />
      <h3 className="text-lg font-semibold text-primary">
        {t("enrichmentsEmpty.title")}
      </h3>
      <p className="max-w-md text-sm text-secondary-foreground">
        {t("enrichmentsEmpty.description")}
      </p>
      <Button
        className="mt-2 min-h-[44px]"
        onClick={() => void navigate(ENRICHMENT_SETTINGS_URL)}
      >
        {t("enrichmentsEmpty.action")}
      </Button>
    </div>
  );
}
