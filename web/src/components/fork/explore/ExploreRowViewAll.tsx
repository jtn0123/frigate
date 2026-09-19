/**
 * Fork: the Explore summary row's "view all" link (UI116).
 *
 * Upstream ended each row with a bare circular arrow whose only label was a
 * tooltip, so on touch there was no way to tell what it did. This is a
 * labeled button in the row header that carries the group's count.
 */

import { useTranslation } from "react-i18next";
import { LuChevronRight } from "react-icons/lu";

type ExploreRowViewAllProps = {
  /** Already translated label of the group, for the accessible name. */
  label: string;
  /** How many tracked objects the group holds, when it is known. */
  count?: number;
  onClick: () => void;
};

export default function ExploreRowViewAll({
  label,
  count,
  onClick,
}: Readonly<ExploreRowViewAllProps>) {
  const { t } = useTranslation(["views/explore"]);

  return (
    <button
      type="button"
      data-testid="explore-row-view-all"
      aria-label={t("exploreMore", { label })}
      onClick={onClick}
      className="flex min-h-[44px] items-center gap-1 rounded-md px-2 text-sm font-medium text-selected hover:underline"
    >
      {count == null
        ? t("viewAll.label", { ns: "fork" })
        : t("viewAll.count", { ns: "fork", count })}
      <LuChevronRight className="size-4" aria-hidden />
    </button>
  );
}
