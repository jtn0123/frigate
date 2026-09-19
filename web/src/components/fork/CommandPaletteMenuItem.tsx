import { LuSearch } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import { DialogClose } from "@/components/ui/dialog";
import { isForkEnabled } from "@/fork/flags";
import { paletteInSettingsMenu } from "@/lib/fork/phone";
import { setCommandPaletteOpen } from "@/hooks/fork/use-command-palette";

/**
 * Phone entry for the command palette, inside the Settings drawer. It takes
 * the place of the bottom bar button (see `paletteInSettingsMenu`) and keeps
 * its test id, so there is still exactly one palette opener per layout.
 */
export default function CommandPaletteMenuItem() {
  const { t } = useTranslation(["fork"]);

  if (!paletteInSettingsMenu || !isForkEnabled("commandPalette")) {
    return null;
  }

  return (
    <DialogClose
      className="flex w-full items-center p-2 text-sm"
      aria-label={t("commandPalette.open")}
      data-testid="command-palette-hint"
      onClick={() => setCommandPaletteOpen(true)}
    >
      <LuSearch className="mr-2 size-4" />
      <span>{t("commandPalette.menuItem")}</span>
    </DialogClose>
  );
}
