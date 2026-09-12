import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MetricHistoryTable from "./MetricHistoryTable";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

describe("MetricHistoryTable", () => {
  it("does not round a small measured allocation down to zero", () => {
    render(
      <MetricHistoryTable
        title="RAM"
        series={[{ name: "Medium", data: [{ x: 1000, y: 1 / 1024 }] }]}
        unit="GiB"
      />,
    );
    expect(screen.getByText("0.0009766 GiB")).toBeTruthy();
  });
  it("keeps missing samples distinct from measured zero and limits visible rows", () => {
    const series = [
      {
        name: "Medium",
        data: Array.from({ length: 30 }, (_, i) => ({
          x: i * 1000,
          y: i === 29 ? null : 0,
        })),
      },
    ];
    render(<MetricHistoryTable title="RAM" series={series} unit="GiB" />);
    fireEvent.click(screen.getByText("models.graphs.table"));
    // jsdom does not implement the native details toggle; open it explicitly.
    screen
      .getByText("models.graphs.table")
      .parentElement?.setAttribute("open", "");
    expect(screen.getByText("models.graphs.gap")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(26);
    expect(screen.getAllByText("0 GiB")).toHaveLength(24);
    fireEvent.click(screen.getByRole("button", { name: "models.graphs.next" }));
    expect(screen.getAllByRole("row")).toHaveLength(6);
    expect(screen.queryByText("models.graphs.gap")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "models.graphs.next" }),
    ).toBeDisabled();
  });
});
