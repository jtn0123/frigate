import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClassificationSuggestionsResponse,
  SuggestionReport,
} from "@/lib/fork/classification-suggestions";
import SuggestionStatusBar from "./SuggestionStatusBar";

let report: SuggestionReport | undefined;
vi.mock("@/hooks/fork/use-suggestion-report", () => ({
  useSuggestionReport: () => ({ data: report }),
}));
const confirmCalls: unknown[][] = [];
vi.mock("@/hooks/fork/use-confirm-suggestion", () => ({
  useConfirmSuggestion:
    () =>
    (...args: unknown[]) => {
      confirmCalls.push(args);
      return Promise.resolve(args[0] !== "fails");
    },
}));
const toastSuccess = vi.fn<(...args: unknown[]) => void>();
const toastWarning = vi.fn<(...args: unknown[]) => void>();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
  },
}));
vi.mock("swr", () => ({ mutate: vi.fn() }));

const GROUPS = {
  a: [{ filename: "a-1.webp" }, { filename: "a-2.webp" }],
  b: [{ filename: "b-1.webp" }],
  fails: [{ filename: "f-1.webp" }],
};
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
  beforeEach(() => {
    confirmCalls.length = 0;
    toastSuccess.mockReset();
    toastWarning.mockReset();
  });

  it("renders nothing before the suggestions arrive", () => {
    render(
      <SuggestionStatusBar
        modelName="vehicle_type"
        data={undefined}
        groups={GROUPS}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("suggestion-status")).toBeNull();
  });

  it("counts drafts and says whether Jev is answering", () => {
    report = undefined;
    render(
      <SuggestionStatusBar
        modelName="vehicle_type"
        data={response({ enabled: true, configured: true, used_today: 3 })}
        groups={GROUPS}
        onRefresh={vi.fn()}
      />,
    );
    const bar = screen.getByTestId("suggestion-status");
    expect(bar).toHaveTextContent('draftsOnPage:{"count":1}');
    expect(bar).toHaveTextContent('jevUsage:{"used":3,"limit":200}');
    expect(bar).not.toHaveTextContent("kept");
  });

  it("explains a missing key and shows the kept rate", async () => {
    report = {
      model: "vehicle_type",
      total: 20,
      accepted: 17,
      rate: 0.85,
      auto_filed: 3,
      sources: {},
      classes: {
        van: {
          total: 10,
          accepted: 8,
          rate: 0.8,
          corrected_to: { suv: 2 },
        },
      },
      cameras: {},
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
        recent_disagreements: [],
      },
    };
    render(
      <MemoryRouter>
        <TooltipProvider>
          <SuggestionStatusBar
            modelName="vehicle_type"
            data={response({ enabled: true })}
            groups={GROUPS}
            onRefresh={vi.fn()}
          />
        </TooltipProvider>
      </MemoryRouter>,
    );
    const bar = screen.getByTestId("suggestion-status");
    expect(bar).toHaveTextContent("jevNoKey");
    expect(bar).toHaveTextContent('kept:{"rate":85,"count":20}');
    expect(screen.getByTestId("suggestion-auto-filed")).toHaveTextContent(
      'autoFiled:{"count":3}',
    );
    expect(screen.getByTestId("suggestion-model-check")).toHaveTextContent(
      'modelAgrees:{"rate":90,"count":40}',
    );
    expect(screen.getByTestId("suggestion-report-link")).toHaveAttribute(
      "href",
      "/classification/suggestions/vehicle_type",
    );

    fireEvent.pointerMove(screen.getByTestId("suggestion-kept"));
    fireEvent.focus(screen.getByTestId("suggestion-kept"));
    await waitFor(() =>
      expect(
        screen.getAllByText(
          'classificationSuggestions.keptClass:{"category":"van","rate":80,"count":10}',
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.getAllByText(
        'classificationSuggestions.correctedTo:{"list":"suv 2"}',
      ).length,
    ).toBeGreaterThan(0);
  });

  it("files every draft on the page after one confirmation", async () => {
    report = undefined;
    const onRefresh = vi.fn();
    const data = response({});
    data.suggestions = { a: DRAFT, b: DRAFT, fails: DRAFT };
    render(
      <SuggestionStatusBar
        modelName="vehicle_type"
        data={data}
        groups={GROUPS}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /fileAll:/ }));
    expect(screen.getByTestId("file-all-dialog")).toBeInTheDocument();
    fireEvent.click(
      screen.getByTestId("file-all-dialog").querySelector("button:last-child")!,
    );

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(confirmCalls).toEqual([
      ["a", ["a-1.webp", "a-2.webp"], DRAFT.suggestion, undefined, true],
      ["b", ["b-1.webp"], DRAFT.suggestion, undefined, true],
      ["fails", ["f-1.webp"], DRAFT.suggestion, undefined, true],
    ]);
    expect(toastWarning).toHaveBeenCalledWith(
      'classificationSuggestions.fileAllDone:{"count":2,"total":3}',
      { position: "top-center" },
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("says Jev is off when it is not enabled", () => {
    report = undefined;
    render(
      <SuggestionStatusBar
        modelName="vehicle_type"
        data={response({})}
        groups={GROUPS}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByTestId("suggestion-status")).toHaveTextContent("jevOff");
  });

  it("warns about lopsided classes and toggles unsure-first (fork I49, I51)", () => {
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
        classes: { suv: 40, sedan: 10 },
        empty: [],
        largest: "suv",
        smallest: "sedan",
        ratio: 4,
        lopsided: true,
      },
    };
    const onUnsureFirst = vi.fn();
    render(
      <MemoryRouter>
        <TooltipProvider>
          <SuggestionStatusBar
            modelName="vehicle_type"
            data={response({})}
            groups={GROUPS}
            onRefresh={vi.fn()}
            unsureFirst={false}
            onUnsureFirst={onUnsureFirst}
          />
        </TooltipProvider>
      </MemoryRouter>,
    );
    const lopsided = screen.getByTestId("suggestion-lopsided");
    expect(lopsided).toHaveTextContent(
      'lopsided:{"largest":"suv","smallest":"sedan","ratio":4}',
    );
    expect(lopsided.getAttribute("href")).toBe(
      "/classification/suggestions/vehicle_type",
    );
    const toggle = screen.getByTestId("train-order-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(onUnsureFirst).toHaveBeenCalledWith(true);
  });

  it("counts the drafts made only of tiny crops without dropping them (fork I50)", () => {
    report = undefined;
    render(
      <MemoryRouter>
        <TooltipProvider>
          <SuggestionStatusBar
            modelName="vehicle_type"
            data={{
              ...response({}),
              too_small: { a: ["a-1.webp", "a-2.webp"] },
            }}
            groups={GROUPS}
            onRefresh={vi.fn()}
          />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("suggestion-status")).toHaveTextContent(
      'draftsOnPage:{"count":1}',
    );
    expect(screen.getByTestId("suggestion-small")).toHaveTextContent(
      'smallDrafts:{"count":1}',
    );
    expect(screen.queryByTestId("train-order-toggle")).toBeNull();
  });
});
