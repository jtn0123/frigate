import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionReport } from "@/lib/fork/classification-suggestions";
import SuggestionReportPage from "./SuggestionReportPage";

let report: SuggestionReport | undefined;
let error: Error | undefined;
vi.mock("@/hooks/fork/use-suggestion-report", () => ({
  useSuggestionReport: () => ({ data: report, error }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/classification/suggestions/vehicle_type"]}>
      <Routes>
        <Route
          path="/classification/suggestions/:model"
          element={<SuggestionReportPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SuggestionReportPage", () => {
  beforeEach(() => {
    report = undefined;
    error = undefined;
  });

  it("shows a spinner, then the tables and disagreements", () => {
    const { unmount } = renderPage();
    expect(screen.getByTestId("suggestion-report")).toHaveTextContent(
      'title:{"model":"vehicle_type"}',
    );
    expect(screen.queryByTestId("report-classes")).toBeNull();
    unmount();

    report = {
      model: "vehicle_type",
      total: 20,
      accepted: 17,
      rate: 0.85,
      auto_filed: 5,
      sources: { jev: { total: 15, accepted: 13, rate: 13 / 15 } },
      classes: {
        van: {
          total: 10,
          accepted: 8,
          rate: 0.8,
          corrected_to: { suv: 2 },
          auto_filed: 5,
        },
      },
      cameras: { yard: { total: 20, accepted: 17, rate: 0.85 } },
      first_time: 1,
      last_time: 2,
      model_check: {
        total: 40,
        accepted: 36,
        rate: 0.9,
        classes: {
          suv: {
            total: 40,
            accepted: 36,
            rate: 0.9,
            corrected_to: { sedan: 4 },
          },
        },
        recent_disagreements: [
          {
            time: 1_700_000_000,
            event_id: "evt-9",
            camera: "yard",
            model_said: "suv",
            draft: "sedan",
          },
        ],
      },
    };
    renderPage();
    expect(screen.getByTestId("report-classes")).toHaveTextContent(
      "van108 (80%)suv 25",
    );
    expect(screen.getByTestId("report-cameras")).toHaveTextContent(
      "yard2017 (85%)",
    );
    expect(screen.getByTestId("report-sources")).toHaveTextContent(
      "jev1513 (87%)",
    );
    expect(screen.getByTestId("report-model-check")).toHaveTextContent(
      "suv4036 (90%)sedan 4",
    );
    const disagreements = screen.getByTestId("report-disagreements");
    expect(disagreements).toHaveTextContent(
      'saidVsDraft:{"said":"suv","draft":"sedan"}',
    );
    expect(disagreements.querySelector("a")?.getAttribute("href")).toBe(
      "/explore?event_id=evt-9",
    );
  });

  it("reports a failed load", () => {
    error = new Error("nope");
    renderPage();
    expect(screen.getByTestId("suggestion-report")).toHaveTextContent(
      "classificationSuggestions.report.failed",
    );
  });
});
