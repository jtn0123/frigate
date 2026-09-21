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
 * upstream `NavItem` in its inactive primary state so the column stays even.
 */
export default function NavSearchButton({
  className,
}: Readonly<NavSearchButtonProps>) {
  const { t } = useTranslation(["fork"]);
  return (
    <ForkNavButton
      variant="sidebar"
      label={t("navSearch.label")}
      data-testid="nav-search"
      className={cn("p-[6px]", className)}
      onClick={() => setCommandPaletteOpen(true)}
    >
      <LuSearch className="size-5" />
    </ForkNavButton>
  );
}
