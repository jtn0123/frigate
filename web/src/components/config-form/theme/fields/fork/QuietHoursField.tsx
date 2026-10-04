/**
 * Fork (D78): the `notifications.quiet_hours` field, at global, camera and
 * profile level. Edits go through the form, so Save sends them with the rest
 * of the section the way every other notification setting is saved.
 */

import type { FieldProps, RJSFSchema } from "@rjsf/utils";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LuTriangleAlert } from "react-icons/lu";
import { Link, useNavigate } from "react-router-dom";

import { SettingsGroupCard } from "@/components/card/SettingsGroupCard";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { settingsLink } from "@/components/config-form/sectionPages";
import { CameraScheduleList } from "@/components/fork/notification-schedule/CameraScheduleList";
import {
  QuietHoursEditor,
  type QuietHoursLabels,
} from "@/components/fork/notification-schedule/QuietHoursEditor";
import {
  QuietStatusBadge,
  type QuietState,
} from "@/components/fork/notification-schedule/QuietStatusBadge";
import {
  UI_SECTION_KEY,
  uiTimezoneDraft,
} from "@/components/fork/notification-schedule/ui-timezone-draft";
import { useScheduleText } from "@/components/fork/notification-schedule/use-schedule-text";
import { isForkEnabled } from "@/fork/flags";
import { use24HourTime } from "@/hooks/use-date-utils";
import { useIsAdmin } from "@/hooks/use-is-admin";
import {
  useNow,
  useScheduleZone,
} from "@/hooks/fork/use-notification-schedule";
import {
  browserTimeZone,
  isValidWindow,
  quietHoursOf,
  quietStatus,
  readDraftWindows,
  sameWindows,
  serverClockOffset,
  wallClock,
  type QuietWindow,
} from "@/lib/fork/notification-schedule";
import { cn } from "@/lib/utils";
import type { ConfigFormContext } from "@/types/configForm";

export function QuietHoursField(props: FieldProps) {
  const isAdmin = useIsAdmin();
  // Viewers can open the notifications page to register a device, but the
  // schedule is an admin setting.
  if (!isForkEnabled("notificationSchedules") || !isAdmin) {
    return null;
  }
  return <QuietHoursFieldBody {...props} />;
}

function itemTitle(schema: RJSFSchema, key: string): string | undefined {
  const items = schema.items;
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    return undefined;
  }
  const property = (items as RJSFSchema).properties?.[key];
  if (typeof property !== "object") {
    return undefined;
  }
  return typeof property.title === "string" ? property.title : undefined;
}

function QuietHoursFieldBody(props: FieldProps) {
  const { schema, onChange, disabled, readonly, name } = props;
  const formData: unknown = props.formData;
  const formContext = props.registry.formContext as
    ConfigFormContext | undefined;
  const { t, i18n } = useTranslation(["fork"]);
  const navigate = useNavigate();
  const config = formContext?.fullConfig;
  const level = formContext?.level ?? "global";
  const isProfile = formContext?.isProfile ?? false;

  // Labels come from the generated config translations, like other fields
  const configT = formContext?.t;
  const prefix = `${formContext?.sectionI18nPrefix ?? "notifications"}.${name}`;
  const label = useCallback(
    (suffix: string, fallback: string | undefined) => {
      const key = `${prefix}.${suffix}`;
      const value = configT?.(key);
      return value && value !== key ? value : (fallback ?? "");
    },
    [configT, prefix],
  );
  const title = label("label", schema.title);
  const labels: QuietHoursLabels = useMemo(
    () => ({
      days: label("days.label", itemTitle(schema, "days")),
      start: label("start.label", itemTitle(schema, "start")),
      end: label("end.label", itemTitle(schema, "end")),
    }),
    [label, schema],
  );

  const format = {
    locale: i18n.language,
    hour12: !use24HourTime(config),
  };
  const { statusText, draftText } = useScheduleText(format);
  const zone = useScheduleZone(config?.ui.timezone, true);
  const now = useNow();
  const clock = useMemo(() => wallClock(now, zone.zone), [now, zone.zone]);

  const windows = useMemo(() => readDraftWindows(formData), [formData]);
  const complete = useMemo(() => windows.filter(isValidWindow), [windows]);
  const draftEnabled = formContext?.formData?.["enabled"] !== false;

  // The badge, the status and the camera rows say what the server does now,
  // so they read the saved config. Unsaved edits only drive the line that
  // says what saving would change.
  const baselineValue = formContext?.baselineFormData?.[name];
  const baseline = useMemo(
    () => readDraftWindows(baselineValue),
    [baselineValue],
  );
  const saved = useMemo(() => baseline.filter(isValidWindow), [baseline]);
  const savedEnabled = formContext?.baselineFormData?.["enabled"] !== false;
  const savedStatus = quietStatus(clock, saved);
  const state: QuietState = !savedEnabled
    ? "off"
    : savedStatus.quiet
      ? "quiet"
      : "notifying";
  const modified = !sameWindows(windows, baseline);
  const draftDiffers = modified || draftEnabled !== savedEnabled;
  // With no windows saved or drafted the editor already says there are none
  const showStatus = savedEnabled && (saved.length > 0 || windows.length > 0);

  const fieldPath = props.fieldPathId.path;
  const handleChange = useCallback(
    (next: QuietWindow[]) => onChange(next, fieldPath),
    [fieldPath, onChange],
  );

  const globalWindows = quietHoursOf(config?.notifications);
  let scope: string;
  if (level === "global") {
    scope = t("notificationSchedule.scope.global");
  } else if (isProfile) {
    scope = t("notificationSchedule.scope.profile");
  } else if (sameWindows(complete, globalWindows)) {
    scope = t("notificationSchedule.scope.inherits");
  } else {
    scope = t("notificationSchedule.scope.own");
  }

  let zoneText: string;
  if (zone.source === "ui") {
    zoneText = t("notificationSchedule.timezone.ui", { zone: zone.zone });
  } else if (zone.source === "server") {
    zoneText = t("notificationSchedule.timezone.server", { zone: zone.zone });
  } else {
    zoneText = t("notificationSchedule.timezone.serverUnknown");
  }
  const browserZone = browserTimeZone();
  const timezoneLink = settingsLink("ui", "global");
  // Minutes the server's clock is off this browser's, when that matters
  const serverOffset = useMemo(
    () => serverClockOffset(zone, browserZone, now),
    [zone, browserZone, now],
  );

  // Open UI settings with this browser's zone as an unsaved change there,
  // so the admin still decides whether to save it
  const onPendingDataChange = formContext?.onPendingDataChange;
  const pendingUi = formContext?.pendingDataBySection?.[UI_SECTION_KEY];
  const suggestBrowserZone = useCallback(() => {
    if (config && onPendingDataChange) {
      onPendingDataChange(
        UI_SECTION_KEY,
        undefined,
        uiTimezoneDraft(config, pendingUi, browserZone),
      );
    }
    if (timezoneLink) {
      void navigate(timezoneLink);
    }
  }, [
    browserZone,
    config,
    navigate,
    onPendingDataChange,
    pendingUi,
    timezoneLink,
  ]);

  let serverWarning: string | undefined;
  if (serverOffset === 0) {
    serverWarning = t("notificationSchedule.timezone.serverSeasonal", {
      zone: zone.zone,
    });
  } else if (serverOffset !== undefined) {
    const hours = Math.abs(serverOffset) / 60;
    serverWarning =
      serverOffset > 0
        ? t("notificationSchedule.timezone.serverAhead", {
            zone: zone.zone,
            count: hours,
          })
        : t("notificationSchedule.timezone.serverBehind", {
            zone: zone.zone,
            count: hours,
          });
  }

  return (
    <div className="w-full max-w-5xl" data-testid="quiet-hours-field">
      <SettingsGroupCard
        title={
          <div className="flex items-center justify-between gap-2">
            <span className={cn(modified && "text-unsaved")}>{title}</span>
            <QuietStatusBadge state={state} testId="quiet-status-scope" />
          </div>
        }
      >
        <div className="space-y-4">
          <div className="max-w-xl space-y-2 text-sm text-primary-variant">
            <p>{t("notificationSchedule.intro")}</p>
            <p>{scope}</p>
            <p data-testid="quiet-hours-exempt">
              {t("notificationSchedule.exempt")}
            </p>
            {serverWarning === undefined && (
              <p className="text-xs text-muted-foreground">
                {zoneText}{" "}
                {zone.source !== undefined && browserZone !== zone.zone && (
                  <>
                    {t("notificationSchedule.timezone.browserDiffers", {
                      zone: browserZone,
                    })}{" "}
                  </>
                )}
                {timezoneLink && (
                  <Link
                    to={timezoneLink}
                    className="text-primary underline underline-offset-4"
                  >
                    {t("notificationSchedule.timezone.change")}
                  </Link>
                )}
              </p>
            )}
          </div>
          {serverWarning !== undefined && (
            <Alert variant="warning" data-testid="quiet-timezone-warning">
              <LuTriangleAlert className="size-4" aria-hidden />
              <AlertTitle className="leading-snug">{serverWarning}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>
                  {t("notificationSchedule.timezone.serverHelp", {
                    zone: browserZone,
                  })}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={suggestBrowserZone}
                >
                  {t("notificationSchedule.timezone.useBrowser", {
                    zone: browserZone,
                  })}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {(showStatus || draftDiffers) && (
            <div className="space-y-1 text-sm">
              {showStatus && (
                <p data-testid="quiet-status-text">
                  {statusText(clock, savedStatus, saved.length)}
                </p>
              )}
              {draftDiffers && (
                <p className="text-unsaved" data-testid="quiet-status-draft">
                  {draftText(
                    clock,
                    quietStatus(clock, complete),
                    complete.length,
                    draftEnabled,
                  )}
                </p>
              )}
            </div>
          )}
          <QuietHoursEditor
            idPrefix={props.fieldPathId.$id}
            windows={windows}
            onChange={handleChange}
            labels={labels}
            format={format}
            disabled={disabled || readonly}
          />
          {level === "global" && config && (
            <CameraScheduleList config={config} clock={clock} />
          )}
        </div>
      </SettingsGroupCard>
    </div>
  );
}
