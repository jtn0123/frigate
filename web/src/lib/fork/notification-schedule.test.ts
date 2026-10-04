import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW,
  dayOffset,
  dayRuns,
  formatMinute,
  isFullDay,
  isOvernight,
  isQuietAt,
  isValidTime,
  nextDays,
  pickScheduleZone,
  quietHoursOf,
  quietStatus,
  readDraftWindows,
  readQuietHours,
  sameWindows,
  serverClockOffset,
  summarizeDays,
  toggleDay,
  utcOffsetMinutes,
  wallClock,
  weekdayName,
  type QuietWindow,
  type WallClock,
} from "./notification-schedule";

const at = (weekday: number, hhmm: string): WallClock => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return { weekday, minute: h * 60 + m };
};

const nightly: QuietWindow[] = [{ days: [], start: "22:00", end: "07:00" }];

describe("readQuietHours", () => {
  it("keeps well-formed windows and sorts their days", () => {
    expect(
      readQuietHours([
        { days: ["sun", "mon", "mon", "funday"], start: "22:00", end: "07:00" },
        { start: "09:00", end: "17:00" },
        { days: [], start: "7:00", end: "08:00" },
        { start: "09:00" },
        "22:00",
        null,
      ]),
    ).toEqual([
      { days: ["mon", "sun"], start: "22:00", end: "07:00" },
      { days: [], start: "09:00", end: "17:00" },
    ]);
  });

  it("reads anything that is not a list as no windows", () => {
    expect(readQuietHours(undefined)).toEqual([]);
    expect(readQuietHours({ start: "22:00" })).toEqual([]);
  });
});

describe("readDraftWindows", () => {
  it("keeps half typed times so the editor does not drop the window", () => {
    expect(
      readDraftWindows([{ days: ["tue", "mon"], start: "", end: 7 }, null]),
    ).toEqual([{ days: ["mon", "tue"], start: "", end: "" }]);
  });
});

describe("quietHoursOf", () => {
  it("reads the windows of a notifications section", () => {
    expect(
      quietHoursOf({ enabled: true, quiet_hours: [DEFAULT_WINDOW] }),
    ).toEqual([DEFAULT_WINDOW]);
    expect(quietHoursOf({ enabled: true })).toEqual([]);
    expect(quietHoursOf(undefined)).toEqual([]);
  });
});

describe("window helpers", () => {
  it("validates 24 hour times", () => {
    expect(isValidTime("00:00")).toBe(true);
    expect(isValidTime("23:59")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("7:30")).toBe(false);
    expect(isValidTime("")).toBe(false);
  });

  it("tells overnight and full day windows apart", () => {
    expect(isOvernight(DEFAULT_WINDOW)).toBe(true);
    expect(isOvernight({ days: [], start: "09:00", end: "17:00" })).toBe(false);
    const day = { days: [], start: "07:00", end: "07:00" };
    expect(isOvernight(day)).toBe(true);
    expect(isFullDay(day)).toBe(true);
    expect(isFullDay(DEFAULT_WINDOW)).toBe(false);
  });

  it("compares window lists by what they schedule", () => {
    expect(
      sameWindows(
        [{ days: ["sun", "mon"], start: "22:00", end: "07:00" }],
        [{ days: ["mon", "sun"], start: "22:00", end: "07:00" }],
      ),
    ).toBe(true);
    expect(sameWindows(nightly, [])).toBe(false);
    expect(
      sameWindows(nightly, [{ days: [], start: "22:00", end: "06:00" }]),
    ).toBe(false);
  });

  it("names the common day sets", () => {
    expect(summarizeDays([])).toBe("everyDay");
    expect(summarizeDays(["fri", "mon", "tue", "wed", "thu"])).toBe("weekdays");
    expect(summarizeDays(["sun", "sat"])).toBe("weekends");
    expect(summarizeDays(["mon"])).toBe("custom");
  });
});

describe("toggleDay", () => {
  it("turns a day off from every day", () => {
    expect(toggleDay([], "sun")).toEqual([
      "mon",
      "tue",
      "wed",
      "thu",
      "fri",
      "sat",
    ]);
  });

  it("stores all seven days as every day", () => {
    expect(
      toggleDay(["mon", "tue", "wed", "thu", "fri", "sat"], "sun"),
    ).toEqual([]);
  });

  it("keeps week order when a day is added", () => {
    expect(toggleDay(["fri", "mon"], "wed")).toEqual(["mon", "wed", "fri"]);
  });

  it("never turns the last day off", () => {
    expect(toggleDay(["mon"], "mon")).toEqual(["mon"]);
  });
});

describe("isQuietAt", () => {
  it("includes the start and excludes the end of a same-day window", () => {
    const work = [{ days: [], start: "09:00", end: "17:00" } as QuietWindow];
    expect(isQuietAt(at(2, "08:59"), work)).toBe(false);
    expect(isQuietAt(at(2, "09:00"), work)).toBe(true);
    expect(isQuietAt(at(2, "17:00"), work)).toBe(false);
  });

  it("wraps an overnight window past midnight", () => {
    expect(isQuietAt(at(2, "21:59"), nightly)).toBe(false);
    expect(isQuietAt(at(2, "22:00"), nightly)).toBe(true);
    expect(isQuietAt(at(3, "06:59"), nightly)).toBe(true);
    expect(isQuietAt(at(3, "07:00"), nightly)).toBe(false);
  });

  it("gives the tail of an overnight window to the day it starts", () => {
    const friday: QuietWindow[] = [
      { days: ["fri"], start: "22:00", end: "07:00" },
    ];
    expect(isQuietAt(at(4, "23:00"), friday)).toBe(true);
    expect(isQuietAt(at(5, "03:00"), friday)).toBe(true);
    expect(isQuietAt(at(4, "03:00"), friday)).toBe(false);
    // Sunday night's tail lands on Monday morning
    const sunday: QuietWindow[] = [
      { days: ["sun"], start: "22:00", end: "07:00" },
    ];
    expect(isQuietAt(at(0, "03:00"), sunday)).toBe(true);
  });

  it("treats equal start and end as a full day", () => {
    const monday: QuietWindow[] = [
      { days: ["mon"], start: "07:00", end: "07:00" },
    ];
    expect(isQuietAt(at(0, "06:59"), monday)).toBe(false);
    expect(isQuietAt(at(0, "07:00"), monday)).toBe(true);
    expect(isQuietAt(at(1, "06:59"), monday)).toBe(true);
    expect(isQuietAt(at(1, "07:00"), monday)).toBe(false);
  });
});

describe("quietStatus", () => {
  it("says when a quiet window ends", () => {
    expect(quietStatus(at(2, "23:30"), nightly)).toEqual({
      quiet: true,
      changesAt: at(3, "07:00"),
    });
  });

  it("says when the next quiet window starts", () => {
    const weeknights: QuietWindow[] = [
      {
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "23:00",
        end: "06:30",
      },
    ];
    // Saturday noon: the next window is Monday night
    expect(quietStatus(at(5, "12:00"), weeknights)).toEqual({
      quiet: false,
      changesAt: at(0, "23:00"),
    });
  });

  it("follows windows that run into each other", () => {
    const chained: QuietWindow[] = [
      { days: [], start: "22:00", end: "00:00" },
      { days: [], start: "00:00", end: "07:00" },
    ];
    expect(quietStatus(at(2, "22:30"), chained)).toEqual({
      quiet: true,
      changesAt: at(3, "07:00"),
    });
  });

  it("never changes without windows or when always quiet", () => {
    expect(quietStatus(at(2, "12:00"), [])).toEqual({
      quiet: false,
      changesAt: null,
    });
    expect(
      quietStatus(at(2, "12:00"), [{ days: [], start: "00:00", end: "00:00" }]),
    ).toEqual({ quiet: true, changesAt: null });
  });
});

describe("dayOffset", () => {
  it("names today, tomorrow, and later", () => {
    expect(dayOffset(at(2, "23:00"), at(2, "23:30"))).toBe("today");
    expect(dayOffset(at(2, "23:00"), at(3, "07:00"))).toBe("tomorrow");
    expect(dayOffset(at(6, "23:00"), at(0, "07:00"))).toBe("tomorrow");
    expect(dayOffset(at(2, "23:00"), at(4, "07:00"))).toBe("later");
    // the same weekday, but a week on
    expect(dayOffset(at(2, "23:00"), at(2, "07:00"))).toBe("later");
  });
});

describe("wallClock", () => {
  it("reads the clock in the given timezone", () => {
    // Thursday 03:30 UTC is Wednesday 22:30 in New York
    const date = new Date(Date.UTC(2026, 0, 15, 3, 30));
    expect(wallClock(date, "UTC")).toEqual(at(3, "03:30"));
    expect(wallClock(date, "America/New_York")).toEqual(at(2, "22:30"));
  });

  it("follows daylight saving time", () => {
    // 2026-03-08 07:00 UTC is 03:00 EDT, a minute after 01:59 EST
    expect(
      wallClock(new Date(Date.UTC(2026, 2, 8, 6, 59)), "America/New_York"),
    ).toEqual(at(6, "01:59"));
    expect(
      wallClock(new Date(Date.UTC(2026, 2, 8, 7, 0)), "America/New_York"),
    ).toEqual(at(6, "03:00"));
  });

  it("falls back to the browser timezone for an unknown zone", () => {
    const date = new Date(Date.UTC(2026, 0, 15, 3, 30));
    expect(wallClock(date, "Not/AZone")).toEqual(wallClock(date));
  });
});

describe("formatting", () => {
  it("formats minutes in 24 and 12 hour time", () => {
    expect(formatMinute(7 * 60, "en-US", false)).toBe("07:00");
    expect(formatMinute(22 * 60 + 30, "en-US", true)).toMatch(/^10:30\sPM$/);
  });

  it("names weekdays from Monday", () => {
    expect(weekdayName(0, "en-US")).toBe("Mon");
    expect(weekdayName(6, "en-US", "long")).toBe("Sunday");
  });
});

describe("pickScheduleZone", () => {
  it("uses the server's answer when it agrees with the config", () => {
    expect(
      pickScheduleZone(undefined, {
        timezone: "Europe/Berlin",
        source: "server",
      }),
    ).toEqual({ zone: "Europe/Berlin", source: "server" });
    expect(
      pickScheduleZone("America/Chicago", {
        timezone: "America/Chicago",
        source: "ui",
      }),
    ).toEqual({ zone: "America/Chicago", source: "ui" });
  });

  it("uses a UI timezone the server has not caught up with", () => {
    expect(
      pickScheduleZone("Asia/Tokyo", { timezone: "UTC", source: "server" }),
    ).toEqual({ zone: "Asia/Tokyo", source: "ui" });
    expect(pickScheduleZone("Asia/Tokyo", undefined)).toEqual({
      zone: "Asia/Tokyo",
      source: "ui",
    });
  });

  it("falls back to the browser before the server answers", () => {
    expect(pickScheduleZone(undefined, undefined).source).toBeUndefined();
    expect(
      pickScheduleZone(undefined, { timezone: "Asia/Tokyo", source: "ui" })
        .source,
    ).toBeUndefined();
  });
});

describe("dayRuns", () => {
  const run = (first: number, last: number, length: number) => ({
    first,
    last,
    length,
  });

  it("groups days in a row", () => {
    expect(dayRuns(["mon", "tue", "wed", "thu", "fri"])).toEqual([
      run(0, 4, 5),
    ]);
    expect(dayRuns(["mon", "wed", "fri"])).toEqual([
      run(0, 0, 1),
      run(2, 2, 1),
      run(4, 4, 1),
    ]);
    expect(dayRuns([])).toEqual([run(0, 6, 7)]);
  });

  it("carries a run on from Sunday into Monday and lists it first", () => {
    expect(dayRuns(["sun", "mon", "tue", "wed", "thu"])).toEqual([
      run(6, 3, 5),
    ]);
    expect(dayRuns(["wed", "sun", "mon"])).toEqual([
      run(6, 0, 2),
      run(2, 2, 1),
    ]);
    expect(dayRuns(["sat", "sun"])).toEqual([run(5, 6, 2)]);
  });
});

describe("nextDays", () => {
  it("moves each day on by one, Sunday into Monday", () => {
    expect(nextDays(["mon", "tue", "wed", "thu", "fri"])).toEqual([
      "tue",
      "wed",
      "thu",
      "fri",
      "sat",
    ]);
    expect(nextDays(["sun"])).toEqual(["mon"]);
    expect(nextDays([])).toEqual([]);
  });
});

describe("utcOffsetMinutes", () => {
  it("reads a zone's offset, daylight saving included", () => {
    const winter = new Date(Date.UTC(2026, 0, 14, 23, 30, 45));
    const summer = new Date(Date.UTC(2026, 6, 14, 23, 30, 45));
    expect(utcOffsetMinutes(winter, "UTC")).toBe(0);
    expect(utcOffsetMinutes(winter, "America/Los_Angeles")).toBe(-480);
    expect(utcOffsetMinutes(summer, "America/Los_Angeles")).toBe(-420);
    expect(utcOffsetMinutes(winter, "Asia/Kolkata")).toBe(330);
  });
});

describe("serverClockOffset", () => {
  const winter = new Date(Date.UTC(2026, 0, 14, 23, 30));
  const summer = new Date(Date.UTC(2026, 6, 14, 23, 30));
  const server = (zone: string) => ({ zone, source: "server" as const });

  it("says how far the server's clock is ahead of the browser's", () => {
    expect(
      serverClockOffset(server("UTC"), "America/Los_Angeles", winter),
    ).toBe(480);
    expect(
      serverClockOffset(server("UTC"), "America/Los_Angeles", summer),
    ).toBe(420);
    expect(serverClockOffset(server("America/New_York"), "UTC", winter)).toBe(
      -300,
    );
  });

  it("flags a zone that only matches until the clocks change", () => {
    expect(serverClockOffset(server("UTC"), "Europe/London", winter)).toBe(0);
    expect(serverClockOffset(server("UTC"), "Europe/London", summer)).toBe(-60);
  });

  it("stays quiet when the clocks always agree or the UI zone decides", () => {
    expect(serverClockOffset(server("UTC"), "UTC", winter)).toBeUndefined();
    expect(serverClockOffset(server("Etc/UTC"), "UTC", summer)).toBeUndefined();
    expect(
      serverClockOffset(
        { zone: "UTC", source: "ui" },
        "America/Los_Angeles",
        winter,
      ),
    ).toBeUndefined();
    expect(
      serverClockOffset(
        { zone: "America/Los_Angeles", source: undefined },
        "UTC",
        winter,
      ),
    ).toBeUndefined();
    expect(
      serverClockOffset(server("Not/AZone"), "UTC", winter),
    ).toBeUndefined();
  });
});
