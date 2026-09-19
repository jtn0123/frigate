import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ExportProgressCard from "./ExportProgressCard";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

describe("ExportProgressCard", () => {
  it("shows the status, name, percent and a determinate bar", () => {
    render(
      <ExportProgressCard name="Garage" stepLabel="Encoding" percent={41.6} />,
    );
    expect(screen.getByText("exportProgress.exporting")).toBeInTheDocument();
    expect(screen.getByText("Garage")).toBeInTheDocument();
    expect(screen.getByText("Encoding · 42%")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
  });

  it("uses an indeterminate bar without a percent", () => {
    render(<ExportProgressCard name="Garage - In Progress" />);
    expect(screen.queryByText(/%$/)).toBeNull();
    expect(screen.getByRole("progressbar")).not.toHaveAttribute(
      "aria-valuenow",
    );
  });

  it("clamps a percent outside 0 to 100", () => {
    render(<ExportProgressCard name="Garage" percent={140} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });
});
