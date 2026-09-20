import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MetricEmptyState, {
  hasNoSamples,
  secondsSince,
  withSamples,
} from "./MetricEmptyState";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

describe("MetricEmptyState", () => {
  it("holds the height of one graph and says why it is empty", () => {
    render(<MetricEmptyState />);
    const state = screen.getByRole("status");
    expect(state).toHaveTextContent("systemMetrics.waiting");
    expect(state.className).toContain("h-[136px]");
  });

  it("names the series it is waiting on", () => {
    render(<MetricEmptyState subjects={["cpu0", "npu"]} />);
    const state = screen.getByRole("status");
    expect(state).toHaveTextContent("systemMetrics.waitingNamed");
    expect(state).not.toHaveAttribute("data-stale");
  });

  it("warns once stats have been arriving without this series", () => {
    const lastUpdated = Date.now() / 1000 - 45;
    render(<MetricEmptyState subjects={["npu"]} lastUpdated={lastUpdated} />);
    const state = screen.getByRole("status");
    expect(state).toHaveTextContent("systemMetrics.staleNamed");
    expect(state).toHaveAttribute("data-stale", "true");
    expect(state).toHaveTextContent("systemMetrics.lastUpdate");
  });

  it("stays neutral while the wait is still short", () => {
    const lastUpdated = Date.now() / 1000 - 2;
    render(<MetricEmptyState lastUpdated={lastUpdated} />);
    const state = screen.getByRole("status");
    expect(state).toHaveTextContent("systemMetrics.waiting");
    expect(state).not.toHaveAttribute("data-stale");
  });

  it("never reports a negative wait", () => {
    const now = 1_000_000;
    expect(secondsSince(now + 5000, now)).toBe(0);
    expect(secondsSince(now - 4400, now)).toBe(4);
  });

  it("counts a card as empty when no series has a sample", () => {
    expect(hasNoSamples(undefined)).toBe(true);
    expect(hasNoSamples([])).toBe(true);
    expect(hasNoSamples([{ data: [] }, { data: [] }])).toBe(true);
    expect(hasNoSamples([{ data: [] }, { data: [{ x: 1, y: 2 }] }])).toBe(
      false,
    );
  });

  it("keeps only the series that have a sample", () => {
    const empty = { name: "a", data: [] };
    const full = { name: "b", data: [{ x: 1, y: 2 }] };
    expect(withSamples([empty, full])).toEqual([full]);
  });
});
