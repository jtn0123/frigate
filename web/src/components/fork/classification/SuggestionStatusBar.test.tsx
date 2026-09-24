import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ClassificationSuggestionsResponse,
  SuggestionReport,
} from "@/lib/fork/classification-suggestions";
import SuggestionStatusBar from "./SuggestionStatusBar";

let report: SuggestionReport | undefined;
vi.mock("@/hooks/fork/use-suggestion-report", () => ({
  useSuggestionReport: () => ({ data: report }),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const DRAFT = {
  text: null,
  jev: null,
  jev_status: "answered",
  suggestion: {
    category: "van",
    source: "jev" as const,
    score: 0.9,
    evidence: "",
  },
  conflict: false,
};

function response(
  jev: Partial<ClassificationSuggestionsResponse["jev"]>,
): ClassificationSuggestionsResponse {
  return {
    model: "vehicle_type",
    classes: ["van"],
    jev: {
      enabled: false,
      configured: false,
      used_today: 0,
      daily_request_limit: 200,
      ...jev,
    },
    suggestions: { a: DRAFT, b: { ...DRAFT, suggestion: null } },
  };
}

describe("SuggestionStatusBar", () => {
  it("renders nothing before the suggestions arrive", () => {
    render(<SuggestionStatusBar modelName="vehicle_type" data={undefined} />);
    expect(screen.queryByTestId("suggestion-status")).toBeNull();
  });

  it("counts drafts and says whether Jev is answering", () => {
    report = undefined;
    render(
      <SuggestionStatusBar
        modelName="vehicle_type"
        data={response({ enabled: true, configured: true, used_today: 3 })}
      />,
    );
    const bar = screen.getByTestId("suggestion-status");
    expect(bar).toHaveTextContent('draftsOnPage:{"count":1}');
    expect(bar).toHaveTextContent('jevUsage:{"used":3,"limit":200}');
    expect(bar).not.toHaveTextContent("kept");
  });

  it("explains a missing key and shows the kept rate", () => {
    report = {
      model: "vehicle_type",
      total: 20,
      accepted: 17,
      rate: 0.85,
      sources: {},
      classes: {},
      cameras: {},
      first_time: 1,
      last_time: 2,
    };
    render(
      <SuggestionStatusBar
        modelName="vehicle_type"
        data={response({ enabled: true })}
      />,
    );
    const bar = screen.getByTestId("suggestion-status");
    expect(bar).toHaveTextContent("jevNoKey");
    expect(bar).toHaveTextContent('kept:{"rate":85,"count":20}');
  });

  it("says Jev is off when it is not enabled", () => {
    report = undefined;
    render(
      <SuggestionStatusBar modelName="vehicle_type" data={response({})} />,
    );
    expect(screen.getByTestId("suggestion-status")).toHaveTextContent("jevOff");
  });
});
