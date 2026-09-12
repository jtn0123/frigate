/**
 * Fork: "Appearance" entry for the settings menu (UI item 15).
 *
 * Mirrors the desktop dropdown submenu / mobile dialog pattern used by the
 * dark mode and theme entries in GeneralSettings so it slots in as a single
 * element there. Renders nothing when the themeControls flag is off.
 */

import { isDesktop } from "react-device-detect";
import { useTranslation } from "react-i18next";
import { LuCheck, LuSlidersHorizontal } from "react-icons/lu";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  densities,
  fontScales,
  useAppearance,
  type Density,
  type FontScale,
} from "@/context/fork/appearance-provider";
import { cn } from "@/lib/utils";

const fontScaleKey: Record<FontScale, string> = {
  0.9: "small",
  1: "default",
  1.1: "large",
  1.25: "larger",
};

type OptionRowProps = {
  selected: boolean;
  label: string;
  testId: string;
  onSelect: () => void;
};

function OptionRow({
  selected,
  label,
  testId,
  onSelect,
}: Readonly<OptionRowProps>) {
  const MenuItem = isDesktop ? DropdownMenuItem : DialogClose;
  return (
    <MenuItem
      className={cn(
        isDesktop ? "cursor-pointer" : "flex items-center p-2 text-sm",
      )}
      role="menuitemradio"
      aria-checked={selected}
      aria-label={label}
      data-testid={testId}
      onClick={onSelect}
    >
      {selected ? (
        <>
          <LuCheck className="mr-2 size-4" />
          {label}
        </>
      ) : (
        <span className="ml-6 mr-2">{label}</span>
      )}
    </MenuItem>
  );
}

export default function AppearanceMenu() {
  const { t } = useTranslation(["fork"]);
  const appearance = useAppearance();

  if (!appearance.enabled) {
    return null;
  }

  const SubItem = isDesktop ? DropdownMenuSub : Dialog;
  const SubItemTrigger = isDesktop ? DropdownMenuSubTrigger : DialogTrigger;
  const SubItemContent = isDesktop ? DropdownMenuSubContent : DialogContent;
  const Portal = isDesktop ? DropdownMenuPortal : DialogPortal;
  const SectionLabel = isDesktop ? DropdownMenuLabel : "div";
  const Separator = isDesktop ? DropdownMenuSeparator : "hr";

  return (
    <SubItem>
      <SubItemTrigger
        className={
          isDesktop ? "cursor-pointer" : "flex items-center p-2 text-sm"
        }
        aria-label={t("appearance.title")}
        data-testid="fork-appearance-trigger"
      >
        <LuSlidersHorizontal className="mr-2 size-4" />
        <span>{t("appearance.title")}</span>
      </SubItemTrigger>
      <Portal>
        <SubItemContent
          className={cn(
            isDesktop ? "w-56" : "w-[92%] rounded-lg md:rounded-2xl",
          )}
          data-testid="fork-appearance-menu"
        >
          {!isDesktop && (
            <>
              <DialogTitle className="sr-only">
                {t("appearance.title")}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t("appearance.title")}
              </DialogDescription>
            </>
          )}
          <SectionLabel className="text-xs text-muted-foreground">
            {t("appearance.density.label")}
          </SectionLabel>
          {densities.map((density: Density) => (
            <OptionRow
              key={density}
              selected={appearance.density === density}
              label={t(`appearance.density.${density}`)}
              testId={`fork-density-${density}`}
              onSelect={() => appearance.setDensity(density)}
            />
          ))}
          <Separator className={cn(!isDesktop && "my-2 border-border")} />
          <SectionLabel className="text-xs text-muted-foreground">
            {t("appearance.fontScale.label")}
          </SectionLabel>
          {fontScales.map((scale: FontScale) => (
            <OptionRow
              key={scale}
              selected={appearance.fontScale === scale}
              label={t(`appearance.fontScale.${fontScaleKey[scale]}`)}
              testId={`fork-font-scale-${fontScaleKey[scale]}`}
              onSelect={() => appearance.setFontScale(scale)}
            />
          ))}
          <Separator className={cn(!isDesktop && "my-2 border-border")} />
          <div
            className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm"
            // Keep the dropdown open while toggling on desktop.
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Label htmlFor="fork-oled-switch" className="cursor-pointer">
              {t("appearance.oled.label")}
            </Label>
            <Switch
              id="fork-oled-switch"
              data-testid="fork-oled-switch"
              checked={appearance.oled}
              onCheckedChange={appearance.setOled}
              aria-label={t("appearance.oled.label")}
            />
          </div>
          <p className="px-2 pb-1 text-xs text-muted-foreground">
            {t("appearance.oled.description")}
          </p>
        </SubItemContent>
      </Portal>
    </SubItem>
  );
}
