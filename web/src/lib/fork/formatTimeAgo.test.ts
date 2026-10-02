import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTimeAgo } from "@/lib/formatTimeAgo";

const NOW = new Date("2026-06-15T12:00:00Z").getTime();
const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("formatTimeAgo", () => {
  it.each([
    [-30, -30, "seconds"],
    [-5 * 60, -5, "minutes"],
    [-3 * 3600, -3, "hours"],
    [-2 * 86400, -2, "days"],
    [-14 * 86400, -2, "weeks"],
    [-90 * 86400, -3, "months"],
    [-800 * 86400, -2, "years"],
    [45, 45, "seconds"],
  ] as const)(
    "formats an offset of %i seconds as %i %s",
    (offset, amount, unit) => {
      expect(formatTimeAgo(new Date(NOW + offset * 1000))).toBe(
        fmt.format(amount, unit),
      );
    },
  );
});
