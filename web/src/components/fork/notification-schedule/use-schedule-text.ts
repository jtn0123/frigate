/** Fork (D78): words for quiet hours windows and their state. */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  dayOffset,
  dayRuns,
  formatMinute,
  isFullDay,
  isOvernight,
  isValidWindow,
  minuteOfDay,
  nextDays,
  summarizeDays,
  weekdayName,
  type QuietStatus,
  type QuietWindow,
  type WallClock,
  type Weekday,
} from "@/lib/fork/notification-schedule";

export type TimeFormat = {
  locale: string;
  hour12: boolean;
};

export type ScheduleText = {
  /**
   * Such as "Weekdays, 9:00 AM to 5:00 PM", or "Mon to Fri nights, 11:00 PM
   * to 6:30 AM" for a window that runs past midnight; undefined while a time
   * is unset.
   */
  windowText: (window: QuietWindow) => string | undefined;
  /**
   * When a window that runs past midnight ends, such as "Ends Tue to Sat
   * mornings"; undefined for any other window.
   */
  endText: (window: QuietWindow) => string | undefined;
  /** When the state next changes, such as "Pushes resume tomorrow at 07:00". */
  statusText: (
    clock: WallClock,
    status: QuietStatus,
    windowCount: number,
  ) => string;
  /** The state unsaved edits would give, such as "After saving: quiet now". */
  draftText: (
    clock: WallClock,
    status: QuietStatus,
    windowCount: number,
    enabled: boolean,
  ) => string;
};

/** Before this minute a window's start reads as day, after it as night. */
const NOON = 12 * 60;

export function useScheduleText({ locale, hour12 }: TimeFormat): ScheduleText {
  const { t } = useTranslation(["fork"]);

  return useMemo(() => {
    const time = (minute: number) => formatMinute(minute, locale, hour12);
    const dayName = (weekday: number) => weekdayName(weekday, locale);

    // "Mon to Fri", "Sat, Sun", or "Sun to Tue, Thu"
    const runsText = (days: Weekday[]): string =>
      dayRuns(days)
        .flatMap((run) => {
          if (run.length >= 3) {
            return [
              t("notificationSchedule.windows.dayRange", {
                first: dayName(run.first),
                last: dayName(run.last),
              }),
            ];
          }
          return Array.from({ length: run.length }, (_, i) =>
            dayName((run.first + i) % 7),
          );
        })
        .join(", ");

    const daysText = (days: Weekday[]): string => {
      switch (summarizeDays(days)) {
        case "everyDay":
          return t("notificationSchedule.windows.everyDay");
        case "weekdays":
          return t("notificationSchedule.windows.weekdays");
        case "weekends":
          return t("notificationSchedule.windows.weekends");
        case "custom":
          return runsText(days);
      }
    };

    // A window past midnight counts on the night it starts, so it names
    // those nights rather than "Weekdays", which reads as the mornings too.
    const startDaysText = (window: QuietWindow): string => {
      const night = minuteOfDay(window.start) >= NOON;
      if (window.days.length === 0) {
        return night
          ? t("notificationSchedule.windows.everyNight")
          : t("notificationSchedule.windows.everyDay");
      }
      const days = runsText(window.days);
      return night
        ? t("notificationSchedule.windows.nights", { days })
        : t("notificationSchedule.windows.startsDays", { days });
    };

    const whenText = (from: WallClock, to: WallClock): string => {
      switch (dayOffset(from, to)) {
        case "today":
          return t("notificationSchedule.when.today", {
            time: time(to.minute),
          });
        case "tomorrow":
          return t("notificationSchedule.when.tomorrow", {
            time: time(to.minute),
          });
        case "later":
          return t("notificationSchedule.when.later", {
            day: weekdayName(to.weekday, locale, "long"),
            time: time(to.minute),
          });
      }
    };

    const statusText = (
      clock: WallClock,
      status: QuietStatus,
      windowCount: number,
    ): string => {
      if (windowCount === 0) {
        return t("notificationSchedule.status.noWindows");
      }
      if (!status.changesAt) {
        return status.quiet
          ? t("notificationSchedule.status.alwaysQuiet")
          : t("notificationSchedule.status.noWindows");
      }
      const when = whenText(clock, status.changesAt);
      return status.quiet
        ? t("notificationSchedule.status.quietUntil", { when })
        : t("notificationSchedule.status.notifyingUntil", { when });
    };

    return {
      windowText: (window) => {
        if (!isValidWindow(window)) {
          return undefined;
        }
        const overnight = isOvernight(window) && !isFullDay(window);
        return t("notificationSchedule.windows.summary", {
          days: overnight ? startDaysText(window) : daysText(window.days),
          start: time(minuteOfDay(window.start)),
          end: time(minuteOfDay(window.end)),
        });
      },
      endText: (window) => {
        if (
          !isValidWindow(window) ||
          !isOvernight(window) ||
          isFullDay(window)
        ) {
          return undefined;
        }
        const end = minuteOfDay(window.end);
        if (end === 0) {
          return t("notificationSchedule.windows.endsMidnight");
        }
        const morning = end < NOON;
        if (window.days.length === 0) {
          return morning
            ? t("notificationSchedule.windows.endsNextMorning")
            : t("notificationSchedule.windows.overnight");
        }
        const days = runsText(nextDays(window.days));
        return morning
          ? t("notificationSchedule.windows.endsMornings", { days })
          : t("notificationSchedule.windows.endsOn", { days });
      },
      statusText,
      draftText: (clock, status, windowCount, enabled) => {
        if (!enabled) {
          return t("notificationSchedule.afterSaving.off");
        }
        if (windowCount === 0) {
          return t("notificationSchedule.afterSaving.none");
        }
        const sentence = statusText(clock, status, windowCount);
        return status.quiet
          ? t("notificationSchedule.afterSaving.quiet", { status: sentence })
          : t("notificationSchedule.afterSaving.notifying", {
              status: sentence,
            });
      },
    };
  }, [hour12, locale, t]);
}
