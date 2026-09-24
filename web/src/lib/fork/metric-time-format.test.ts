import { describe, expect, it } from "vitest";
import { metricTimeFormatKey } from "./metric-time-format";

const HOUR = 3600;
const TIME = "time.formattedTimestampHourMinute.12hour";
const DATE = "time.formattedTimestampMonthDay";

describe("metricTimeFormatKey", () => {
  it("keeps the time of day for the live window", () => {
    expect(metricTimeFormatKey([0, 15, 20 * 60], "12hour")).toBe(TIME);
  });

  it("keeps the time of day across a day", () => {
    expect(metricTimeFormatKey([0, 24 * HOUR], "12hour")).toBe(TIME);
  });

  it("follows the clock setting", () => {
    expect(metricTimeFormatKey([0, HOUR], "24hour")).toBe(
      "time.formattedTimestampHourMinute.24hour",
    );
  });

  it("labels the date once the samples span more than two days", () => {
    expect(metricTimeFormatKey([0, 7 * 24 * HOUR], "12hour")).toBe(DATE);
    expect(metricTimeFormatKey([0, 30 * 24 * HOUR], "24hour")).toBe(DATE);
  });

  it("keeps the time of day with no samples yet", () => {
    expect(metricTimeFormatKey([], "12hour")).toBe(TIME);
  });
});
