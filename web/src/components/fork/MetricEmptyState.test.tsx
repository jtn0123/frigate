import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MetricEmptyState, {
  hasNoSamples,
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
