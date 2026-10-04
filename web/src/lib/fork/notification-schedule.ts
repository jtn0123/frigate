/**
 * Fork (D78): pure logic behind the notification quiet hours editor.
 *
 * Mirrors `frigate/fork/notification_schedule.py`: windows are read on the
 * wall clock of the schedule's timezone, an end at or before the start runs
 * past midnight and belongs to the day it starts on, and no days means every
 * day.
 */

export const WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export type QuietWindow = {
  days: Weekday[];
  start: string;
  end: string;
};

/** A moment on a wall clock: weekday 0 is Monday, minute 0 is midnight. */
export type WallClock = {
  weekday: number;
  minute: number;
};

export type QuietStatus = {
  quiet: boolean;
  /** When the state next flips, or null when it never does. */
  changesAt: WallClock | null;
};

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A new window: every night, 22:00 to 07:00. */
export const DEFAULT_WINDOW: QuietWindow = {
  days: [],
  start: "22:00",
  end: "07:00",
};

export function isValidTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

export function minuteOfDay(hhmm: string): number {
  const [hours = 0, minutes = 0] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

function isWeekday(value: unknown): value is Weekday {
  return (
    typeof value === "string" && (WEEKDAYS as readonly string[]).includes(value)
  );
}

function sortDays(days: Iterable<Weekday>): Weekday[] {
  const chosen = new Set(days);
  return WEEKDAYS.filter((day) => chosen.has(day));
}

/**
 * Read quiet hours windows as the form holds them, times possibly half typed.
 *
 * Args:
 *     value: The `quiet_hours` list as it came from the form.
 *
 * Returns:
 *     One window per object in the list, days in week order and a time that
 *     is not a string read as empty.
 */
export function readDraftWindows(value: unknown): QuietWindow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const windows: QuietWindow[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const { days, start, end } = item as Record<string, unknown>;
    const validDays = Array.isArray(days)
      ? (days as unknown[]).filter(isWeekday)
      : [];
    windows.push({
      days: sortDays(validDays),
      start: typeof start === "string" ? start : "",
      end: typeof end === "string" ? end : "",
    });
  }
  return windows;
}

/** Whether both times of a window are complete. */
export function isValidWindow(window: QuietWindow): boolean {
  return isValidTime(window.start) && isValidTime(window.end);
}

/**
 * Read quiet hours windows from config data, dropping anything malformed.
 *
 * Args:
 *     value: The `quiet_hours` list as it came from the config or the form.
 *
 * Returns:
 *     The well-formed windows, days in week order.
 */
export function readQuietHours(value: unknown): QuietWindow[] {
  return readDraftWindows(value).filter(isValidWindow);
}

/** The well-formed `quiet_hours` of a notifications config section. */
export function quietHoursOf(section: unknown): QuietWindow[] {
  if (typeof section !== "object" || section === null) {
    return [];
  }
  return "quiet_hours" in section ? readQuietHours(section.quiet_hours) : [];
}

function windowKey(window: QuietWindow): string {
  return `${sortDays(window.days).join()}|${window.start}|${window.end}`;
}

/** Whether two window lists schedule the same thing. */
export function sameWindows(a: QuietWindow[], b: QuietWindow[]): boolean {
  return a.map(windowKey).join(";") === b.map(windowKey).join(";");
}

/** Whether a window runs past midnight (equal times make it a full day). */
export function isOvernight(window: QuietWindow): boolean {
  return minuteOfDay(window.end) <= minuteOfDay(window.start);
}

export function isFullDay(window: QuietWindow): boolean {
  return window.start === window.end;
}

/** Whether a window starts on `day`; no days means every day. */
export function startsOn(window: QuietWindow, day: Weekday): boolean {
  return window.days.length === 0 || window.days.includes(day);
}

/** Whether a window starts on a weekday, 0 being Monday. */
function startsOnWeekday(window: QuietWindow, weekday: number): boolean {
  return (
    window.days.length === 0 ||
    window.days.some((day) => WEEKDAYS.indexOf(day) === weekday)
  );
}

/**
 * Turn one day of a window on or off.
 *
 * All seven days are stored as an empty list, and the last chosen day cannot
 * be turned off, since an empty list would mean every day again.
 */
export function toggleDay(days: Weekday[], day: Weekday): Weekday[] {
  const current = days.length === 0 ? [...WEEKDAYS] : sortDays(days);
  const next = current.includes(day)
    ? current.filter((d) => d !== day)
    : sortDays([...current, day]);
  if (next.length === 0) {
    return days;
  }
  return next.length === WEEKDAYS.length ? [] : next;
}

export type DaysSummary = "everyDay" | "weekdays" | "weekends" | "custom";

export function summarizeDays(days: Weekday[]): DaysSummary {
  const sorted = sortDays(days).join();
  if (days.length === 0) return "everyDay";
  if (sorted === "mon,tue,wed,thu,fri") return "weekdays";
  if (sorted === "sat,sun") return "weekends";
  return "custom";
}

/** Days in a row; weekday 0 is Monday, and `last` wraps past Sunday. */
export type DayRun = {
  first: number;
  last: number;
  length: number;
};

/**
 * Group days into runs of days in a row, reading the week as a circle so
 * that Sunday to Tuesday is one run.
 *
 * Args:
 *     days: The chosen days; none means every day.
 *
 * Returns:
 *     The runs in week order, except that a run carrying on from Sunday
 *     into Monday comes first, since it holds the earliest Monday.
 */
export function dayRuns(days: Weekday[]): DayRun[] {
  const chosen = new Set(
    (days.length === 0 ? WEEKDAYS : days).map((day) => WEEKDAYS.indexOf(day)),
  );
  if (chosen.size === WEEKDAYS.length) {
    return [{ first: 0, last: 6, length: 7 }];
  }
  const runs: DayRun[] = [];
  for (const first of chosen) {
    if (chosen.has((first + 6) % 7)) continue;
    let length = 1;
    while (chosen.has((first + length) % 7)) length += 1;
    runs.push({ first, last: (first + length - 1) % 7, length });
  }
  const order = (run: DayRun) => (run.last < run.first ? -1 : run.first);
  return runs.sort((a, b) => order(a) - order(b));
}

const NEXT_DAY: Record<Weekday, Weekday> = {
  mon: "tue",
  tue: "wed",
  wed: "thu",
  thu: "fri",
  fri: "sat",
  sat: "sun",
  sun: "mon",
};

/** The day after each of `days`, such as the mornings overnight windows end. */
export function nextDays(days: Weekday[]): Weekday[] {
  return sortDays(days.map((day) => NEXT_DAY[day]));
}

function timeZoneFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  // en-US with a 23 hour cycle only to parse the parts; nothing is shown
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

const SHORT_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The wall clock of `date` in `timeZone`. An unknown zone falls back to the
 * browser's own.
 */
export function wallClock(date: Date, timeZone?: string): WallClock {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = timeZoneFormatter(timeZone);
  } catch {
    formatter = timeZoneFormatter(undefined);
  }
  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of formatter.formatToParts(date)) {
    if (part.type === "weekday") weekday = SHORT_WEEKDAYS.indexOf(part.value);
    if (part.type === "hour") hour = Number(part.value) % 24;
    if (part.type === "minute") minute = Number(part.value);
  }
  return { weekday, minute: hour * 60 + minute };
}

/** Whether the wall clock falls inside any window. */
export function isQuietAt(clock: WallClock, windows: QuietWindow[]): boolean {
  const today = clock.weekday;
  const yesterday = (clock.weekday + 6) % 7;
  return windows.some((window) => {
    const start = minuteOfDay(window.start);
    const end = minuteOfDay(window.end);
    if (start < end) {
      return (
        startsOnWeekday(window, today) &&
        clock.minute >= start &&
        clock.minute < end
      );
    }
    return (
      (startsOnWeekday(window, today) && clock.minute >= start) ||
      (startsOnWeekday(window, yesterday) && clock.minute < end)
    );
  });
}

function minuteOfWeek(clock: WallClock): number {
  return clock.weekday * MINUTES_PER_DAY + clock.minute;
}

function clockAt(minuteInWeek: number): WallClock {
  const wrapped =
    ((minuteInWeek % MINUTES_PER_WEEK) + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
  return {
    weekday: Math.floor(wrapped / MINUTES_PER_DAY),
    minute: wrapped % MINUTES_PER_DAY,
  };
}

/**
 * Whether the clock is quiet, and when that next changes.
 *
 * The change is found on the wall clock, the same one the windows are written
 * on, by testing every window edge in the coming week in order.
 */
export function quietStatus(
  clock: WallClock,
  windows: QuietWindow[],
): QuietStatus {
  const quiet = isQuietAt(clock, windows);
  const now = minuteOfWeek(clock);
  const offsets = new Set<number>();
  for (const window of windows) {
    const start = minuteOfDay(window.start);
    const end = minuteOfDay(window.end);
    WEEKDAYS.forEach((day, weekday) => {
      if (!startsOn(window, day)) return;
      const startAt = weekday * MINUTES_PER_DAY + start;
      const endAt =
        weekday * MINUTES_PER_DAY + end + (end <= start ? MINUTES_PER_DAY : 0);
      for (const edge of [startAt, endAt]) {
        const offset =
          (((edge - now) % MINUTES_PER_WEEK) + MINUTES_PER_WEEK) %
          MINUTES_PER_WEEK;
        offsets.add(offset === 0 ? MINUTES_PER_WEEK : offset);
      }
    });
  }
  const sorted = [...offsets].sort((a, b) => a - b);
  for (const offset of sorted) {
    const at = clockAt(now + offset);
    if (isQuietAt(at, windows) !== quiet) {
      return { quiet, changesAt: at };
    }
  }
  return { quiet, changesAt: null };
}

/**
 * How far ahead `to` is from `from`: the same day, the next, or later.
 *
 * Returns:
 *     "today", "tomorrow", or "later" for anything further out (including
 *     the same weekday a week on).
 */
export function dayOffset(
  from: WallClock,
  to: WallClock,
): "today" | "tomorrow" | "later" {
  const ahead =
    (((minuteOfWeek(to) - minuteOfWeek(from)) % MINUTES_PER_WEEK) +
      MINUTES_PER_WEEK) %
    MINUTES_PER_WEEK;
  const days = (to.weekday - from.weekday + 7) % 7;
  if (days === 0 && ahead < MINUTES_PER_DAY) return "today";
  if (days === 1) return "tomorrow";
  return "later";
}

/** A minute of the day as a localized time, such as "07:00" or "7:00 AM". */
export function formatMinute(
  minute: number,
  locale: string,
  hour12: boolean,
): string {
  const date = new Date(Date.UTC(2024, 0, 1, 0, minute));
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    hour12,
    timeZone: "UTC",
  }).format(date);
}

/** A localized weekday name; weekday 0 is Monday. */
export function weekdayName(
  weekday: number,
  locale: string,
  width: "narrow" | "short" | "long" = "short",
): string {
  // 2024-01-01 was a Monday
  const date = new Date(Date.UTC(2024, 0, 1 + weekday, 12));
  return new Intl.DateTimeFormat(locale, {
    weekday: width,
    timeZone: "UTC",
  }).format(date);
}

/** The browser's own timezone, used before the server has said its own. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export type ScheduleZone = {
  /** IANA name of the zone the windows are read in. */
  zone: string;
  /** Where it came from; undefined while the server has not said. */
  source: "ui" | "server" | undefined;
};

/**
 * The timezone quiet hours run on, as the browser best knows it.
 *
 * The server's answer wins while it agrees with the loaded config about
 * whether a UI timezone is set. When they disagree the answer is older than
 * the config (the timezone was just changed), so the config wins.
 *
 * Args:
 *     uiZone: `ui.timezone` from the loaded config.
 *     server: The schedule endpoint's answer, once loaded.
 */
export function pickScheduleZone(
  uiZone: string | undefined,
  server: { timezone: string; source: "ui" | "server" } | undefined,
): ScheduleZone {
  if (server && (server.source === "ui") === Boolean(uiZone)) {
    return { zone: server.timezone, source: server.source };
  }
  if (uiZone) {
    return { zone: uiZone, source: "ui" };
  }
  return { zone: browserTimeZone(), source: undefined };
}

/**
 * A timezone's offset from UTC at a moment, in minutes ahead of UTC.
 *
 * Throws:
 *     RangeError: For a zone the browser does not know.
 */
export function utcOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
  );
  // The wall clock has no seconds, so compare it with the minute it is in
  const minute = Math.floor(date.getTime() / 60_000) * 60_000;
  return Math.round((wall - minute) / 60_000);
}

/**
 * How far the server's own clock, which quiet hours follow while no UI
 * timezone is set, is from this browser's.
 *
 * Zones with other names that keep the same time all year, such as UTC and
 * Etc/UTC, are one clock. January and July are compared as well as now, so
 * a zone that only agrees until the next daylight saving change still
 * counts as different.
 *
 * Args:
 *     zone: The zone quiet hours run on.
 *     browserZone: This browser's zone.
 *     now: The moment to compare at.
 *
 * Returns:
 *     Minutes the server's clock is ahead of the browser's now (negative
 *     when behind, zero when they differ only in another season), or
 *     undefined when quiet hours follow the UI timezone, the clocks always
 *     agree, or a zone is unknown.
 */
export function serverClockOffset(
  zone: ScheduleZone,
  browserZone: string,
  now: Date,
): number | undefined {
  if (zone.source !== "server" || zone.zone === browserZone) {
    return undefined;
  }
  const year = now.getUTCFullYear();
  const moments = [
    now,
    new Date(Date.UTC(year, 0, 1)),
    new Date(Date.UTC(year, 6, 1)),
  ];
  let gaps: number[];
  try {
    gaps = moments.map(
      (moment) =>
        utcOffsetMinutes(moment, zone.zone) -
        utcOffsetMinutes(moment, browserZone),
    );
  } catch {
    return undefined;
  }
  return gaps.some((gap) => gap !== 0) ? gaps[0] : undefined;
}
