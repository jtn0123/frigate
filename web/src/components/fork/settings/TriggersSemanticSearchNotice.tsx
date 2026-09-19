/**
 * Fork: the Triggers page's "needs semantic search" notice (UI104).
 *
 * Upstream showed a red destructive alert, but semantic search being off is a
 * missing prerequisite, not an error. This is a neutral notice that explains
 * why triggers need it and links straight to the Semantic search settings.
 */

import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { LuExternalLink, LuInfo } from "react-icons/lu";
import { Button } from "@/components/ui/button";

type TriggersSemanticSearchNoticeProps = {
  /** Localized documentation URL for semantic search. */
  docsUrl: string;
};

const SEMANTIC_SEARCH_SETTINGS_URL = "/settings?page=integrationSemanticSearch";

export default function TriggersSemanticSearchNotice({
  docsUrl,
}: Readonly<TriggersSemanticSearchNoticeProps>) {
  const { t } = useTranslation(["fork", "common"]);
  const navigate = useNavigate();

  return (
    <section
      role="status"
      data-testid="triggers-semantic-search-notice"
      className="flex max-w-3xl gap-3 rounded-lg border border-selected/30 bg-selected/5 p-4 md:p-5"
    >
      <LuInfo className="mt-0.5 size-5 shrink-0 text-selected" aria-hidden />
      <div className="flex flex-col gap-2">
        <h5 className="text-base font-semibold text-primary">
          {t("triggersNotice.title")}
        </h5>
        <p className="text-sm text-primary-variant">
          {t("triggersNotice.description")}
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            variant="select"
            onClick={() => void navigate(SEMANTIC_SEARCH_SETTINGS_URL)}
          >
            {t("triggersNotice.openSettings")}
          </Button>
          <Button variant="outline" asChild>
            <Link to={docsUrl} target="_blank" rel="noopener noreferrer">
              <LuExternalLink className="mr-2 size-4" aria-hidden />
              {t("readTheDocumentation", { ns: "common" })}
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
