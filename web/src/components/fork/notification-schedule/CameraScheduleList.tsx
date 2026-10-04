/** Fork (D78): each camera's quiet hours state, on the global schedule page. */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { LuPencil } from "react-icons/lu";

import { CameraNameLabel } from "@/components/camera/FriendlyNameLabel";
import { settingsLink } from "@/components/config-form/sectionPages";
import { resolveCameraName } from "@/hooks/use-camera-friendly-name";
import { phoneTouch } from "@/lib/fork/phone";
import type { WallClock } from "@/lib/fork/notification-schedule";
import { cn } from "@/lib/utils";
import type { FrigateConfig } from "@/types/frigateConfig";

import { cameraRows } from "./camera-rows";
import { QuietStatusBadge } from "./QuietStatusBadge";

type CameraScheduleListProps = {
  /** The saved config; unsaved edits do not change a camera's state. */
  config: FrigateConfig;
  clock: WallClock;
};

export function CameraScheduleList({
  config,
  clock,
}: Readonly<CameraScheduleListProps>) {
  const { t } = useTranslation(["fork"]);
  const rows = useMemo(() => cameraRows(config, clock), [config, clock]);

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2" data-testid="quiet-camera-list">
      <div className="text-sm font-medium">
        {t("notificationSchedule.cameras.title")}
      </div>
      <ul className="divide-y divide-border/60 rounded-lg bg-secondary">
        {rows.map((row) => {
          const link = settingsLink("notifications", "camera", row.name);
          let scope: string;
          if (!row.own) {
            scope = t("notificationSchedule.cameras.usesGlobal");
          } else if (row.own.length === 0) {
            scope = t("notificationSchedule.cameras.ownNone");
          } else {
            scope = t("notificationSchedule.cameras.own", {
              count: row.own.length,
            });
          }
          return (
            <li
              key={row.name}
              className="flex items-center gap-3 px-3 py-2"
              data-testid={`quiet-camera-${row.name}`}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <CameraNameLabel
                  camera={row.name}
                  className="truncate text-sm smart-capitalize"
                />
                <span className="text-xs text-muted-foreground">{scope}</span>
              </div>
              <QuietStatusBadge
                state={row.state}
                testId={`quiet-status-${row.name}`}
              />
              {link && (
                <Link
                  to={link}
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    // a fingertip needs 44 px on a phone
                    phoneTouch ? "size-11" : "size-9",
                  )}
                  aria-label={t("notificationSchedule.cameras.edit", {
                    camera: resolveCameraName(config, row.name),
                  })}
                >
                  <LuPencil className="size-4" aria-hidden />
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
