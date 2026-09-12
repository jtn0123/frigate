import { LuSearch } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import ForkNavButton, {
  type ForkNavVariant,
} from "@/components/fork/ForkNavButton";
import { forkNavIconClass } from "@/lib/fork/nav-icon";
import { setCommandPaletteOpen } from "@/hooks/fork/use-command-palette";

type CommandPaletteHintProps = {
  variant: ForkNavVariant;
  large?: boolean;
};

export default function CommandPaletteHint({
  variant,
  large = false,
}: Readonly<CommandPaletteHintProps>) {
  const { t } = useTranslation(["fork"]);
  return (
    <ForkNavButton
      variant={variant}
      large={large}
      label={t("commandPalette.open")}
      data-testid="command-palette-hint"
      onClick={() => setCommandPaletteOpen(true)}
    >
      <LuSearch className={forkNavIconClass(large)} />
    </ForkNavButton>
  );
}
