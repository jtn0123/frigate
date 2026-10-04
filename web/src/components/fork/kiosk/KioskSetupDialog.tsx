/**
 * Wall display setup (UI19, flag `kioskMode`): pick the groups, layout,
 * cycle and overlays, then open `/kiosk` here or copy its link for the
 * display's own browser.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { LuCopy, LuGrid2X2, LuMonitorPlay, LuSquare } from "react-icons/lu";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAllowedCameras } from "@/hooks/use-allowed-cameras";
import {
  CYCLE_CHOICES,
  DEFAULT_GROUP,
  DEFAULT_KIOSK_SETTINGS,
  TILE_CHOICES,
  kioskRoute,
  kioskUrl,
  resolveKioskSources,
  type KioskMode,
  type KioskSettings,
} from "@/lib/fork/kiosk";
import { enterPageFullscreen } from "@/lib/fork/kiosk-fullscreen";
import type { FrigateConfig } from "@/types/frigateConfig";

type KioskSetupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Live's current group, checked when the dialog opens. */
  currentGroup: string | undefined;
};

type GroupChoice = { key: string; label: string; count: number };

export default function KioskSetupDialog({
  open,
  onOpenChange,
  currentGroup,
}: Readonly<KioskSetupDialogProps>) {
  const { t } = useTranslation(["fork"]);
  const cycleLabel = (seconds: number): string => {
    if (seconds === 0) return t("kiosk.setup.cycleOff");
    if (seconds < 60) return t("kiosk.setup.seconds", { count: seconds });
    return t("kiosk.setup.minutes", { count: seconds / 60 });
  };
  const navigate = useNavigate();
  const { data: config } = useSWR<FrigateConfig>("config");
  const allowedCameras = useAllowedCameras();

  const choices = useMemo<GroupChoice[]>(() => {
    if (!config) return [];
    const count = (key: string) =>
      resolveKioskSources(
        config,
        { ...DEFAULT_KIOSK_SETTINGS, groups: [key] },
        allowedCameras,
      )[0]?.cameras.length ?? 0;
    const groups = Object.entries(config.camera_groups)
      .filter(([key]) => key !== DEFAULT_GROUP)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([key]) => ({
        key,
        label: key.replaceAll("_", " "),
        count: count(key),
      }));
    return [
      {
        key: DEFAULT_GROUP,
        label: t("kiosk.allCameras"),
        count: count(DEFAULT_GROUP),
      },
      ...groups,
    ].filter((choice) => choice.count > 0);
  }, [config, allowedCameras, t]);

  const [settings, setSettings] = useState<KioskSettings>(
    DEFAULT_KIOSK_SETTINGS,
  );

  // Start from Live's current group each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const group =
      currentGroup && config?.camera_groups[currentGroup]
        ? currentGroup
        : DEFAULT_GROUP;
    setSettings({ ...DEFAULT_KIOSK_SETTINGS, groups: [group] });
  }, [open, currentGroup, config]);

  const update = (patch: Partial<KioskSettings>) =>
    setSettings((current) => ({ ...current, ...patch }));

  const toggleGroup = (key: string, checked: boolean) => {
    const selected = new Set(settings.groups);
    if (checked) selected.add(key);
    else selected.delete(key);
    // keep the dialog's order, which is Live's group order
    update({
      groups: choices
        .map((choice) => choice.key)
        .filter((choiceKey) => selected.has(choiceKey)),
    });
  };

  const valid = settings.groups.length > 0;
  const url = valid ? kioskUrl(settings) : "";
  const grid = settings.mode === "grid";

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("kiosk.setup.copied"));
    } catch {
      toast.error(t("kiosk.setup.copyFailed"));
    }
  };

  const openDisplay = () => {
    // Fullscreen must be asked for inside the click; the in-app navigation
    // that follows keeps the document fullscreen.
    void enterPageFullscreen();
    onOpenChange(false);
    void navigate(kioskRoute(settings));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        data-testid="kiosk-setup"
      >
        <DialogHeader>
          <DialogTitle>{t("kiosk.setup.title")}</DialogTitle>
          <DialogDescription>{t("kiosk.setup.description")}</DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">
            {t("kiosk.setup.groups")}
          </legend>
          {choices.map((choice) => {
            const id = `kiosk-group-${choice.key}`;
            return (
              <div key={choice.key} className="flex items-center gap-3">
                <Checkbox
                  id={id}
                  checked={settings.groups.includes(choice.key)}
                  onCheckedChange={(checked) =>
                    toggleGroup(choice.key, checked === true)
                  }
                />
                <Label
                  htmlFor={id}
                  className="flex flex-1 cursor-pointer items-baseline justify-between gap-2 font-normal"
                >
                  <span className="smart-capitalize">{choice.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("kiosk.setup.cameraCount", { count: choice.count })}
                  </span>
                </Label>
              </div>
            );
          })}
          {!valid && (
            <p className="text-sm text-danger" role="alert">
              {t("kiosk.setup.pickGroup")}
            </p>
          )}
          {settings.groups.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {t("kiosk.setup.groupsCycle")}
            </p>
          )}
        </fieldset>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium" id="kiosk-mode-label">
            {t("kiosk.setup.layout")}
          </span>
          <ToggleGroup
            type="single"
            size="sm"
            value={settings.mode}
            aria-labelledby="kiosk-mode-label"
            className="justify-start gap-2 *:gap-2 *:rounded-md *:border *:px-3"
            onValueChange={(value) => {
              if (value === "grid" || value === "single") {
                update({ mode: value satisfies KioskMode });
              }
            }}
          >
            <ToggleGroupItem value="grid">
              <LuGrid2X2 aria-hidden className="size-4" />
              {t("kiosk.setup.modeGrid")}
            </ToggleGroupItem>
            <ToggleGroupItem value="single">
              <LuSquare aria-hidden className="size-4" />
              {t("kiosk.setup.modeSingle")}
            </ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            {grid
              ? t("kiosk.setup.modeGridHint")
              : t("kiosk.setup.modeSingleHint")}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="kiosk-cycle">{t("kiosk.setup.cycle")}</Label>
            <Select
              value={String(settings.cycle)}
              onValueChange={(value) => update({ cycle: Number(value) })}
            >
              <SelectTrigger id="kiosk-cycle" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CYCLE_CHOICES.map((seconds) => (
                  <SelectItem key={seconds} value={String(seconds)}>
                    {cycleLabel(seconds)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {grid && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="kiosk-tiles">{t("kiosk.setup.tiles")}</Label>
              <Select
                value={String(settings.tiles)}
                onValueChange={(value) => update({ tiles: Number(value) })}
              >
                <SelectTrigger id="kiosk-tiles" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TILE_CHOICES.map((tiles) => (
                    <SelectItem key={tiles} value={String(tiles)}>
                      {tiles === 0
                        ? t("kiosk.setup.tilesAll")
                        : t("kiosk.setup.tilesUpTo", { count: tiles })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          {grid && (
            <SwitchRow
              id="kiosk-saved-layout"
              label={t("kiosk.setup.savedLayout")}
              hint={t("kiosk.setup.savedLayoutHint")}
              checked={settings.savedLayout}
              onChange={(checked) => update({ savedLayout: checked })}
            />
          )}
          <SwitchRow
            id="kiosk-clock"
            label={t("kiosk.setup.clock")}
            checked={settings.clock}
            onChange={(checked) => update({ clock: checked })}
          />
          <SwitchRow
            id="kiosk-alerts"
            label={t("kiosk.setup.alerts")}
            hint={t("kiosk.setup.alertsHint")}
            checked={settings.alerts}
            onChange={(checked) => update({ alerts: checked })}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="kiosk-link">{t("kiosk.setup.link")}</Label>
          {/* wraps, so the whole link shows: its end holds options too */}
          <Textarea
            id="kiosk-link"
            readOnly
            rows={2}
            value={url}
            className="min-h-0 resize-none break-all font-mono text-xs"
            data-testid="kiosk-setup-url"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="text-xs text-muted-foreground">
            {t("kiosk.setup.tip")}
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!valid}
            onClick={() => void copyLink()}
          >
            <LuCopy aria-hidden className="mr-2 size-4" />
            {t("kiosk.setup.copy")}
          </Button>
          <Button
            type="button"
            variant="select"
            disabled={!valid}
            onClick={openDisplay}
            data-testid="kiosk-setup-open"
          >
            <LuMonitorPlay aria-hidden className="mr-2 size-4" />
            {t("kiosk.setup.open")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}>) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
