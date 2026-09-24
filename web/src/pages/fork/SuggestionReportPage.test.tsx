import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionReport } from "@/lib/fork/classification-suggestions";
import SuggestionReportPage from "./SuggestionReportPage";

let report: SuggestionReport | undefined;
let error: Error | undefined;
vi.mock("@/hooks/fork/use-suggestion-report", () => ({
  useSuggestionReport: () => ({ data: report, error }),
}));
const spotChecks: [string, boolean][] = [];
vi.mock("@/hooks/fork/use-spot-check", () => ({
  useSpotCheck: () => (group: { event_id: string | null }, keep: boolean) => {
    spotChecks.push([group.event_id ?? "", keep]);
    return Promise.resolve(true);
  },
}));
vi.mock("@/api/baseUrl", () => ({ baseUrl: "http://frigate/" }));
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

  it("shows class balance, the training gap and a spot check (fork I51, I52, I54)", async () => {
    spotChecks.length = 0;
    report = {
      model: "vehicle_type",
      total: 0,
      accepted: 0,
      rate: null,
      sources: {},
      classes: {},
      cameras: {},
      first_time: null,
      last_time: null,
      dataset: {
        classes: { suv: 40, sedan: 10, none: 0 },
        empty: ["none"],
        largest: "suv",
        smallest: "sedan",
        ratio: 4,
        lopsided: true,
      },
      training: {
        has_trained: false,
        last_training_date: null,
        current_images: 50,
        new_images: 50,
      },
      recent_auto_filed: [
        {
          time: 1_700_000_000,
          event_id: "evt-1",
          camera: "yard",
          category: "suv",
          source: "jev",
          score: 0.97,
          files: ["suv-a.png", "suv-b.png"],
        },
      ],
    };
    renderPage();
    const balance = screen.getByTestId("report-balance");
    expect(balance).toHaveTextContent(
      'lopsided:{"largest":"suv","smallest":"sedan","ratio":4}',
    );
    expect(balance).toHaveTextContent('emptyClasses:{"list":"none"}');
    expect(balance).toHaveTextContent("suv40");
    expect(screen.getByTestId("suggestion-report")).toHaveTextContent(
      "newSinceTraining50",
    );
    expect(screen.getByTestId("suggestion-report")).toHaveTextContent(
      "neverTrained",
    );
    const check = screen.getByTestId("report-spot-check");
    expect(check).toHaveTextContent('spotCheck:{"count":1}');
    const group = screen.getByTestId("spot-check-group");
    expect(group.querySelector("img")?.getAttribute("src")).toBe(
      "http://frigate/clips/vehicle_type/dataset/suv/suv-a.png",
    );
    expect(group).toHaveTextContent('imageCount:{"count":2}');
    fireEvent.click(
      screen.getByRole("button", {
        name: "classificationSuggestions.report.remove",
      }),
    );
    await waitFor(() => expect(spotChecks).toEqual([["evt-1", false]]));
    fireEvent.click(
      screen.getByRole("button", {
        name: "classificationSuggestions.report.keep",
      }),
    );
    await waitFor(() => expect(spotChecks.length).toBe(2));
    expect(spotChecks[1]).toEqual(["evt-1", true]);
  });

  it("reports a failed load", () => {
    error = new Error("nope");
    renderPage();
    expect(screen.getByTestId("suggestion-report")).toHaveTextContent(
      "classificationSuggestions.report.failed",
    );
  });
});
