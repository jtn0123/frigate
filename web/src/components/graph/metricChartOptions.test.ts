import { describe, expect, it, vi } from "vitest";
import { createMetricChartOptions } from "./metricChartOptions";

describe("metric chart options", () => {
  it.each([true, false])(
    "keeps responsive axes and the caller's time formatter (mobile: %s)",
    (mobile) => {
      const formatTime = vi.fn(() => "12:34");
      const options = createMetricChartOptions({
        graphId: "camera-fps",
        theme: "dark",
        mobile,
        formatTime,
      });
      expect(options.chart?.id).toBe("camera-fps");
      expect(options.xaxis?.tickAmount).toBe(mobile ? 2 : 3);
      expect(options.xaxis?.labels?.formatter).toBe(formatTime);
      expect(options.tooltip?.theme).toBe("dark");
      expect(options.yaxis).toMatchObject({ min: 0, max: undefined });
    },
  );

  it("preserves the threshold chart's explicit upper bound", () => {
    const options = createMetricChartOptions({
      graphId: "cpu",
      theme: "light",
      mobile: false,
      formatTime: String,
      yMax: 125,
    });
    expect(options.yaxis).toMatchObject({ min: 0, max: 125 });
  });

  it("does not share mutable nested options between charts", () => {
    const args = {
      graphId: "cpu",
      theme: "light",
      mobile: false,
      formatTime: String,
    };
    const first = createMetricChartOptions(args);
    const second = createMetricChartOptions(args);
    // ApexCharts may mutate its options while rendering or updating a chart.
    first.xaxis!.labels!.style!.colors = "red";
    first.chart!.id = "changed";
    expect(second.xaxis?.labels?.style?.colors).toBe("#6B6B6B");
    expect(second.chart?.id).toBe("cpu");
  });
});
