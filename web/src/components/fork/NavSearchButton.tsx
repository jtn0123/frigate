import { isForkEnabled } from "@/fork/flags";
import { useMatch } from "react-router-dom";
import { LuSearch } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import ForkNavButton from "@/components/fork/ForkNavButton";
import { setCommandPaletteOpen } from "@/hooks/fork/use-command-palette";
import { cn } from "@/lib/utils";

type NavSearchButtonProps = {
  className?: string;
};

/**
 * The rail's magnifier. Opens the command palette rather than navigating, so
 * one box covers pages, cameras, settings and footage. Styled to match the
 * rail entries, with a current-page cue while viewing Explore.
 */
export default function NavSearchButton({
  className,
}: Readonly<NavSearchButtonProps>) {
  const { t } = useTranslation(["fork"]);
  const exploreMatch = useMatch("/explore/*");
  return (
    <ForkNavButton
      variant="sidebar"
      label={t("navSearch.label")}
      hint={isForkEnabled("themeControls") ? t("navSearch.hint") : undefined}
      data-testid="nav-search"
      aria-current={exploreMatch ? "page" : undefined}
      className={cn("p-[6px]", className)}
      onClick={() => setCommandPaletteOpen(true)}
    >
      <LuSearch className="size-5" />
    </ForkNavButton>
  );
}
