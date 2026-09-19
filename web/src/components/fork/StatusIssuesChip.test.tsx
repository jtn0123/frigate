import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { StatusMessagesState } from "@/context/statusbar-context";
import StatusIssuesChip from "./StatusIssuesChip";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

const messages: StatusMessagesState = {
  stats: [
    {
      id: "a",
      text: "Host collector is missing or stale.",
      color: "text-warning",
      link: "/system#models",
    },
    { id: "b", text: "AI or telemetry needs attention", color: "text-warning" },
  ],
};

function renderChip(state: StatusMessagesState) {
  return render(
    <MemoryRouter>
      <StatusIssuesChip messages={state} />
    </MemoryRouter>,
  );
}

describe("StatusIssuesChip", () => {
  it("renders nothing without messages", () => {
    const { container } = renderChip({ stats: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a counted chip instead of the sentences", () => {
    renderChip(messages);
    const chip = screen.getByTestId("status-issues-chip");
    expect(chip).toHaveTextContent("statusAlerts.count:2");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip.className).toContain("amber");
    expect(screen.queryByText("AI or telemetry needs attention")).toBeNull();
  });

  it("lists every message with a link when it has one", () => {
    renderChip(messages);
    const chip = screen.getByTestId("status-issues-chip");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByTestId("status-issues-list");
    expect(list).toHaveTextContent("Host collector is missing or stale.");
    expect(list).toHaveTextContent("AI or telemetry needs attention");
    // only the message with a link gets one
    const link = screen.getByRole("link", { name: /statusAlerts.open/ });
    expect(link).toHaveAttribute("href", "/system#models");

    fireEvent.click(link);
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("turns red when a message is an error", () => {
    renderChip({ stats: [{ id: "c", text: "Detectors are slow" }] });
    expect(screen.getByTestId("status-issues-chip").className).toContain("red");
  });
});
