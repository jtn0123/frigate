import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import NavigationMetrics from "./NavigationMetrics";
import {
  clearNavigationSamples,
  recordNavigationSample,
} from "@/lib/fork/navigation-metrics";

it("distinguishes missing measurements from real timings and clears the display", () => {
  clearNavigationSamples();
  render(<NavigationMetrics />);
  expect(screen.getAllByText("navigation.metrics.unmeasured")).toHaveLength(2);
  act(() => {
    recordNavigationSample({
      kind: "request",
      target: "cases",
      duration: 12,
      outcome: "success",
    });
    recordNavigationSample({
      kind: "request",
      target: "exports",
      duration: 5,
      outcome: "cancelled",
    });
    recordNavigationSample({
      kind: "request",
      target: "exports",
      duration: 20,
      outcome: "error",
    });
    recordNavigationSample({
      kind: "page",
      target: "exports",
      duration: 30,
      outcome: "success",
    });
  });
  expect(screen.getByText("12 ms")).toBeInTheDocument();
  expect(screen.getByText("30 ms")).toBeInTheDocument();
  fireEvent.click(screen.getByText("navigation.metrics.clear"));
  expect(screen.getAllByText("navigation.metrics.unmeasured")).toHaveLength(2);
});
