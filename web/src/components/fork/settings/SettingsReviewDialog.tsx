/**
 * Fork: "Review changes" dialog shown before Save All.
 *
 * Lists every pending section with its `key: old -> new` rows and whether
 * saving it requires a restart. Save delegates to the upstream Save All
 * handler unchanged; Cancel just closes the dialog.
 */

import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LuRefreshCcw } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  registerSettingsReviewHost,
  setSettingsReviewOpen,
  useSettingsDiff,
  useSettingsNavStore,
} from "@/hooks/fork/use-settings-nav";
import type { SettingsSectionDiff } from "@/lib/fork/settings-diff";

export default function SettingsReviewDialog() {
  const { t } = useTranslation(["fork", "views/settings", "common"]);
  const { published, reviewOpen } = useSettingsNavStore();
  const sections = useSettingsDiff();

  useEffect(() => registerSettingsReviewHost(), []);

  const formatValue = useCallback(
    (value: unknown) => {
      if (value === undefined) return t("settingsNav.review.defaultValue");
      if (value === "") return t("settingsNav.review.reset");
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        // BigInt and circular values cannot be serialized; name the type
        // rather than printing "[object Object]".
        return typeof value === "bigint" ? value.toString() : typeof value;
      }
    },
    [t],
  );

  const sectionTitle = useCallback(
    (section: SettingsSectionDiff) => {
      const menuKey = published?.pendingKeyToMenuKey(section.pendingKey);
      return menuKey
        ? t(`menu.${menuKey}`, {
            ns: "views/settings",
            defaultValue: section.section,
          })
        : section.section;
    },
    [published, t],
  );

  const onSave = useCallback(() => {
    setSettingsReviewOpen(false);
    published?.saveAll();
  }, [published]);

  return (
    <Dialog open={reviewOpen} onOpenChange={setSettingsReviewOpen}>
      <DialogContent
        className="max-h-[85dvh] overflow-hidden sm:max-w-2xl"
        data-testid="settings-review-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("settingsNav.review.title")}</DialogTitle>
          <DialogDescription>
            {t("settingsNav.review.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="scrollbar-container flex max-h-[55dvh] flex-col gap-3 overflow-y-auto pr-1">
          {sections.length === 0 && (
            <div className="text-sm text-muted-foreground">
              {t("settingsNav.review.empty")}
            </div>
          )}
          {sections.map((section) => (
            <div
              key={section.pendingKey}
              className="rounded-md border border-secondary bg-background_alt p-3"
              data-testid="settings-review-section"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-primary-variant">
                  {sectionTitle(section)}
                </span>
                <Badge variant="secondary" className="text-xs font-normal">
                  {section.scope === "global"
                    ? t("settingsNav.review.global")
                    : t("settingsNav.review.camera", {
                        cameraName: section.cameraName,
                      })}
                </Badge>
                {section.profileName && (
                  <Badge variant="outline" className="text-xs font-normal">
                    {t("settingsNav.review.profile", {
                      profileName: section.profileName,
                    })}
                  </Badge>
                )}
                {section.needsRestart && (
                  <Badge
                    variant="outline"
                    className="gap-1 text-xs font-normal text-muted-foreground"
                    data-testid="settings-review-restart"
                  >
                    <LuRefreshCcw className="size-3" />
                    {t("settingsNav.restartRequired")}
                  </Badge>
                )}
              </div>
              <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">
                  {t("settingsNav.review.field")}
                </span>
                <span className="text-muted-foreground">
                  {t("settingsNav.review.from")}
                </span>
                <span />
                <span className="text-muted-foreground">
                  {t("settingsNav.review.to")}
                </span>
                {section.changes.map((change) => (
                  <div
                    key={change.path}
                    className="contents"
                    data-testid="settings-review-change"
                  >
                    <span className="min-w-0 break-all font-mono">
                      {change.path || section.section}
                    </span>
                    <span className="min-w-0 whitespace-pre-wrap break-all font-mono text-muted-foreground">
                      {formatValue(change.oldValue)}
                    </span>
                    <span className="text-muted-foreground">{"->"}</span>
                    <span
                      className={cn(
                        "min-w-0 whitespace-pre-wrap break-all font-mono",
                        change.newValue === "" && "italic",
                      )}
                    >
                      {formatValue(change.newValue)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setSettingsReviewOpen(false)}
          >
            {t("button.cancel", { ns: "common" })}
          </Button>
          <Button
            type="button"
            variant="select"
            disabled={
              !published || published.saveDisabled || sections.length === 0
            }
            onClick={onSave}
          >
            {t("button.saveAll", { ns: "common" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
