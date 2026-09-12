import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enUS } from "date-fns/locale";
import {
  convertLocalDateToTimestamp,
  convertTo12Hour,
  dateToLong,
  endOfHourOrCurrentTime,
  epochToLong,
  formatDateToLocaleString,
  formatSecondsToDuration,
  formatUnixTimestampToDateTime,
  getBeginningOfDayTimestamp,
  getDurationFromTimestamps,
  getEndOfDayTimestamp,
  getIntlDateFormat,
  getNowYesterdayInLong,
  getRangeForTimestamp,
  getUTCOffset,
  isCurrentHour,
  isValidTimeRange,
  longToDate,
  to24Hour,
} from "./dateUtil";

// The real i18n module boots i18next with an HTTP backend; replace it with a
// tiny lookup so the strings this module reads are deterministic.
vi.mock("@/utils/i18n", () => {
  const table: Record<string, string> = {
    "time.am": "am",
    "time.pm": "pm",
    "time.inProgress": "In Progress",
    "time.invalidStartTime": "Invalid start time",
    "time.invalidEndTime": "Invalid end time",
    "time.hour_one": "{{time}} hour",
    "time.hour_other": "{{time}} hours",
    "time.minute_one": "{{time}} minute",
    "time.minute_other": "{{time}} minutes",
    "time.second_one": "{{time}} second",
    "time.second_other": "{{time}} seconds",
  };
  return {
    default: {
      t: (key: string, opts?: { time?: number }) =>
        (table[key] ?? key).replace("{{time}}", String(opts?.time)),
    },
  };
});

// 2024-01-15T13:45:00Z
const TS = 1705326300;

type Part = { type: string; value: string };

// Force the locale date order seen by Intl.DateTimeFormat().formatToParts().
function mockDateOrder(order: Array<"year" | "month" | "day">) {
  const parts: Part[] = order.flatMap((type, i) =>
    i === 0
      ? [{ type, value: "1" }]
      : [
          { type: "literal", value: "/" },
          { type, value: "1" },
        ],
  );
  const fake = function () {
    return { formatToParts: () => parts };
  } as unknown as typeof Intl.DateTimeFormat;
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(fake);
}

describe("epoch helpers", () => {
  it("round-trips between seconds and Date", () => {
    const date = longToDate(TS);
    expect(date.toISOString()).toBe("2024-01-15T13:45:00.000Z");
    expect(dateToLong(date)).toBe(TS);
    expect(epochToLong(1500)).toBe(1.5);
  });

  it("getNowYesterdayInLong is exactly 24h before now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TS * 1000));
    expect(getNowYesterdayInLong()).toBe(TS - 24 * 60 * 60);
    vi.useRealTimers();
  });
});

describe("formatUnixTimestampToDateTime", () => {
  it("returns Invalid time for NaN", () => {
    expect(formatUnixTimestampToDateTime(Number.NaN)).toBe("Invalid time");
  });

  it("uses a strftime-style date_format in the requested timezone", () => {
    expect(
      formatUnixTimestampToDateTime(TS, {
        timezone: "UTC",
        date_format: "yyyy-MM-dd HH:mm",
      }),
    ).toBe("2024-01-15 13:45");
    expect(
      formatUnixTimestampToDateTime(TS, {
        timezone: "Asia/Kolkata",
        date_format: "HH:mm",
      }),
    ).toBe("19:15");
  });

  it("upper-cases the translated am/pm marker for 12 hour date_format", () => {
    expect(
      formatUnixTimestampToDateTime(TS, {
        timezone: "UTC",
        date_format: "h:mm a",
      }),
    ).toBe("1:45 PM");
  });

  it("accepts a date-fns Locale object", () => {
    expect(
      formatUnixTimestampToDateTime(TS, {
        timezone: "UTC",
        date_format: "EEEE",
        locale: enUS,
      }),
    ).toBe("Monday");
  });

  it("formats with Intl styles in 24 hour mode", () => {
    expect(
      formatUnixTimestampToDateTime(TS, {
        timezone: "UTC",
        date_style: "short",
        time_style: "short",
        time_format: "24hour",
        locale: "en-US",
      }),
    ).toBe("1/15/24, 13:45");
  });

  it("formats with Intl styles in 12 hour mode", () => {
    expect(
      formatUnixTimestampToDateTime(TS, {
        timezone: "UTC",
        date_style: "short",
        time_style: "short",
        time_format: "12hour",
        locale: "en-US",
      }),
    ).toMatch(/^1\/15\/24, 1:45\sPM$/);
  });

  it("falls back to the browser language when no locale is given", () => {
    const result = formatUnixTimestampToDateTime(TS, {
      timezone: "UTC",
      time_style: "short",
      time_format: "24hour",
    });
    expect(result).toContain("13:45");
  });
});

describe("getDurationFromTimestamps", () => {
  it("reports invalid start and end times", () => {
    expect(getDurationFromTimestamps(Number.NaN, 10)).toBe(
      "Invalid start time",
    );
    expect(getDurationFromTimestamps(0, Number.NaN)).toBe("Invalid end time");
  });

  it("reports In Progress when there is no end time", () => {
    expect(getDurationFromTimestamps(0, null)).toBe("In Progress");
  });

  it("uses singular and plural forms", () => {
    expect(getDurationFromTimestamps(0, 3661)).toBe("1 hour 1 minute 1 second");
    expect(getDurationFromTimestamps(0, 7325)).toBe(
      "2 hours 2 minutes 5 seconds",
    );
  });

  it("omits zero components", () => {
    expect(getDurationFromTimestamps(0, 60)).toBe("1 minute");
    expect(getDurationFromTimestamps(0, 0)).toBe("");
  });

  it("abbreviates when asked", () => {
    expect(getDurationFromTimestamps(0, 7325, true)).toBe("2h 2m 5s");
  });
});

describe("formatSecondsToDuration", () => {
  it("rejects negative and NaN input", () => {
    expect(formatSecondsToDuration(-1)).toBe("Invalid duration");
    expect(formatSecondsToDuration(Number.NaN)).toBe("Invalid duration");
  });

  it("formats hours, minutes and seconds with the default locale", () => {
    expect(formatSecondsToDuration(3661)).toBe("1 hour, 1 minute, 1 second");
    expect(formatSecondsToDuration(90)).toBe("1 minute, 30 seconds");
  });
});

describe("getUTCOffset", () => {
  const date = new Date(TS * 1000);

  it("parses UTC+-HH:MM strings directly", () => {
    expect(getUTCOffset(date, "UTC+05:30")).toBe(330);
    expect(getUTCOffset(date, "UTC-04:00")).toBe(-240);
  });

  it("computes the offset of a named zone", () => {
    expect(getUTCOffset(date, "America/New_York")).toBe(-300);
    expect(getUTCOffset(date, "Asia/Kolkata")).toBe(330);
    // The UTC offset comes back as -0; toBe(0) compares with Object.is.
    expect(getUTCOffset(date, "UTC")).toBeCloseTo(0);
  });

  it("honours DST for the given date", () => {
    expect(
      getUTCOffset(new Date("2024-07-15T12:00:00Z"), "Europe/Berlin"),
    ).toBe(120);
    expect(
      getUTCOffset(new Date("2024-01-15T12:00:00Z"), "Europe/Berlin"),
    ).toBe(60);
  });

  it("falls back to the resolved zone when timezone is null", () => {
    expect(Number.isInteger(getUTCOffset(date, null))).toBe(true);
  });
});

describe("hour and day ranges", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("getRangeForTimestamp floors to the hour and ends an hour later", () => {
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const expectedStart = new Date(TS * 1000);
    expectedStart.setMinutes(0, 0, 0);
    const start = expectedStart.getTime() / 1000;
    expect(getRangeForTimestamp(TS)).toEqual({ start, end: start + 3600 });
  });

  it("getRangeForTimestamp never extends past now", () => {
    const expectedStart = new Date(TS * 1000);
    expectedStart.setMinutes(0, 0, 0);
    const start = expectedStart.getTime() / 1000;
    vi.setSystemTime(new Date((start + 600) * 1000));
    expect(getRangeForTimestamp(TS).end).toBe(start + 600);
  });

  it("endOfHourOrCurrentTime clamps to now", () => {
    vi.setSystemTime(new Date(TS * 1000));
    expect(endOfHourOrCurrentTime(TS + 1000)).toBe(TS);
    expect(endOfHourOrCurrentTime(TS - 1000)).toBe(TS - 1000);
  });

  it("isCurrentHour compares against the start of the current hour", () => {
    vi.setSystemTime(new Date(TS * 1000));
    expect(isCurrentHour(TS + 300)).toBe(true);
    expect(isCurrentHour(TS - 3600)).toBe(false);
  });

  it("beginning and end of day mutate the date in local time", () => {
    const start = new Date(2024, 0, 15, 10, 30, 15, 500);
    expect(getBeginningOfDayTimestamp(start)).toBe(
      new Date(2024, 0, 15, 0, 0, 0, 0).getTime() / 1000,
    );
    expect(start.getHours()).toBe(0);

    const end = new Date(2024, 0, 15, 10, 30);
    expect(getEndOfDayTimestamp(end)).toBe(
      new Date(2024, 0, 15, 23, 59, 59, 999).getTime() / 1000,
    );
  });
});

describe("convertLocalDateToTimestamp", () => {
  const expected = new Date("2024-03-05T00:00:00").getTime();

  it("rejects strings that are not exactly 8 digits", () => {
    expect(convertLocalDateToTimestamp("2024-03-05")).toBe(0);
    expect(convertLocalDateToTimestamp("240305")).toBe(0);
  });

  it("parses day-month-year locales", () => {
    mockDateOrder(["day", "month", "year"]);
    expect(convertLocalDateToTimestamp("05032024")).toBe(expected);
  });

  it("parses month-day-year locales", () => {
    mockDateOrder(["month", "day", "year"]);
    expect(convertLocalDateToTimestamp("03052024")).toBe(expected);
  });

  it("parses year-month-day locales", () => {
    mockDateOrder(["year", "month", "day"]);
    expect(convertLocalDateToTimestamp("20240305")).toBe(expected);
  });

  it("returns 0 for impossible dates and unknown orders", () => {
    mockDateOrder(["month", "day", "year"]);
    expect(convertLocalDateToTimestamp("13052024")).toBe(0);
    vi.restoreAllMocks();
    mockDateOrder(["day", "month"]);
    expect(convertLocalDateToTimestamp("05032024")).toBe(0);
  });
});

describe("locale date strings", () => {
  it("getIntlDateFormat describes the order with DD, MM and YYYY", () => {
    const format = getIntlDateFormat();
    expect(format).toHaveLength(8);
    expect(format).toContain("DD");
    expect(format).toContain("MM");
    expect(format).toContain("YYYY");
  });

  it("getIntlDateFormat follows the resolved locale order", () => {
    mockDateOrder(["year", "month", "day"]);
    expect(getIntlDateFormat()).toBe("YYYYMMDD");
  });

  it("formatDateToLocaleString returns digits only and applies the offset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 15, 12));
    const today = formatDateToLocaleString();
    expect(today).toMatch(/^\d{8}$/);
    expect(today).toContain("2024");
    expect(today).toContain("15");
    expect(formatDateToLocaleString(1)).toContain("16");
    vi.useRealTimers();
  });
});

describe("to24Hour", () => {
  it("passes 24 hour input through untouched", () => {
    expect(to24Hour("23:15")).toBe("23:15");
    expect(to24Hour("07:05", "24hour")).toBe("07:05");
  });

  it("converts am/pm edge cases", () => {
    expect(to24Hour("12:30AM", "12hour")).toBe("00:30");
    expect(to24Hour("12:30PM", "12hour")).toBe("12:30");
    expect(to24Hour("1:05pm", "12hour")).toBe("13:05");
    expect(to24Hour("9:07 AM", "browser")).toBe("09:07");
  });

  it("throws on input without an am/pm marker", () => {
    expect(() => to24Hour("13:00", "12hour")).toThrow(/Invalid time format/);
  });
});

describe("isValidTimeRange", () => {
  it("requires exactly two comma separated times", () => {
    expect(isValidTimeRange("08:00", "24hour")).toBe(false);
    expect(isValidTimeRange("08:00,09:00,10:00", "24hour")).toBe(false);
  });

  it("validates 24 hour ranges and ordering", () => {
    expect(isValidTimeRange("08:00,17:00", "24hour")).toBe(true);
    expect(isValidTimeRange("08:00, 24:00", "24hour")).toBe(true);
    expect(isValidTimeRange("17:00,08:00", "24hour")).toBe(false);
    expect(isValidTimeRange("08:00,08:00", "24hour")).toBe(false);
    expect(isValidTimeRange("25:00,26:00", "24hour")).toBe(false);
  });

  it("validates 12 hour ranges", () => {
    expect(isValidTimeRange("8:00AM,5:00PM", "12hour")).toBe(true);
    expect(isValidTimeRange("8:00am,5:00pm", "browser")).toBe(true);
    expect(isValidTimeRange("13:00PM,5:00PM", "12hour")).toBe(false);
    expect(isValidTimeRange("5:00PM,8:00AM", "12hour")).toBe(false);
  });
});

describe("convertTo12Hour", () => {
  it("maps midnight and noon correctly", () => {
    expect(convertTo12Hour("00:15")).toBe("12:15 AM");
    expect(convertTo12Hour("12:00")).toBe("12:00 PM");
  });

  it("converts afternoon hours", () => {
    expect(convertTo12Hour("13:05")).toBe("1:05 PM");
    expect(convertTo12Hour("09:30")).toBe("9:30 AM");
  });
});
