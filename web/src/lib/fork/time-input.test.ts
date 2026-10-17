import { describe, expect, it } from "vitest";
import { parseTimeInput } from "./time-input";

describe("time input parsing", () => {
  it.each([
    "",
    "09",
    "09:",
    "09:1",
    "09:18:",
    "24:00",
    "09:60",
    "09:18:60",
    "-1:00",
    "NaN:00",
    "09:18suffix",
  ])("rejects incomplete or invalid clocks: %s", (clock) => {
    expect(parseTimeInput(clock, 1234, false)).toBeNull();
  });
  it.each([NaN, Infinity, -Infinity, 1e20])(
    "rejects an invalid starting timestamp: %s",
    (timestamp) => {
      expect(parseTimeInput("09:18", timestamp, false)).toBeNull();
    },
  );
  it.each([false, true])(
    "accepts midnight and the last minute of the selected date (iOS: %s)",
    (ios) => {
      const timestamp = new Date(2026, 8, 12, 12).getTime() / 1000;
      expect(parseTimeInput("00:00", timestamp, ios)).toBe(
        new Date(2026, 8, 12).getTime() / 1000,
      );
      expect(parseTimeInput("23:59:59", timestamp, ios)).toBe(
        new Date(2026, 8, 12, 23, 59, ios ? 0 : 59).getTime() / 1000,
      );
    },
  );
});
