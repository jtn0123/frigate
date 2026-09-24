import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MetricRangeToggle, { rangeNote } from "./MetricRangeToggle";
import { METRIC_RANGES } from "@/hooks/fork/use-system-metrics-history";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

describe("MetricRangeToggle", () => {
  it("offers the live window and every stored range", () => {
    render(
      <MetricRangeToggle
        range="live"
        onRangeChange={vi.fn()}
        status="connected"
      />,
    );

    expect(
      screen
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual([...METRIC_RANGES]);
  });

  it("reports the range the user picked", () => {
    const onRangeChange = vi.fn();
    render(
      <MetricRangeToggle
        range="live"
        onRangeChange={onRangeChange}
        status="connected"
      />,
    );

    fireEvent.change(screen.getByTestId("metric-range"), {
      target: { value: "24h" },
    });

    expect(onRangeChange).toHaveBeenCalledWith("24h");
  });
});

describe("rangeNote", () => {
  it("says how much time a point covers", () => {
    expect(rangeNote("24h", "connected", 900)).toEqual({
      key: "systemMetrics.range.averagedMinutes",
      count: 15,
    });
    expect(rangeNote("30d", "connected", 14400)).toEqual({
      key: "systemMetrics.range.averagedHours",
      count: 4,
    });
  });

  it("describes the live window, which averages nothing", () => {
    expect(rangeNote("live", "connected", undefined)?.key).toBe(
      "systemMetrics.range.liveNote",
    );
  });

  it("says nothing while a stored range is still loading", () => {
    expect(rangeNote("7d", "connected", undefined)).toBeUndefined();
  });

  it("explains a history that is off, unreadable or not filled yet", () => {
    expect(rangeNote("7d", "disabled", 900)?.key).toBe(
      "systemMetrics.range.disabled",
    );
    expect(rangeNote("7d", "unavailable", 900)?.key).toBe(
      "systemMetrics.range.unavailable",
    );
    expect(rangeNote("7d", "empty", 900)?.key).toBe(
      "systemMetrics.range.empty",
    );
  });
});
