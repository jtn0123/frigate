import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClassificationSuggestionsResponse,
  SuggestionReport,
} from "@/lib/fork/classification-suggestions";
import SuggestionStatusBar from "./SuggestionStatusBar";

let report: SuggestionReport | undefined;
let hintSeen = true;
let hintLoaded = true;
const dismissHint = vi.fn(() => {
  hintSeen = true;
});
vi.mock("@/hooks/fork/use-suggestion-hint", () => ({
  useSuggestionHint: () => [hintSeen, dismissHint, hintLoaded],
}));
vi.mock("@/hooks/fork/use-suggestion-report", () => ({
  useSuggestionReport: () => ({ data: report }),
}));
const confirmCalls: unknown[][] = [];
let confirmImpl: (...args: unknown[]) => Promise<boolean> = (...args) =>
  Promise.resolve(args[0] !== "fails");
vi.mock("@/hooks/fork/use-confirm-suggestion", () => ({
  useConfirmSuggestion:
    () =>
    (...args: unknown[]) => {
      confirmCalls.push(args);
      return confirmImpl(...args);
    },
}));
const toastSuccess = vi.fn<(...args: unknown[]) => void>();
const toastWarning = vi.fn<(...args: unknown[]) => void>();
const toastError = vi.fn<(...args: unknown[]) => void>();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));
vi.mock("swr", () => ({ mutate: vi.fn(() => Promise.resolve()) }));

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
const SUV = {
  ...DRAFT,
  suggestion: { ...DRAFT.suggestion, category: "suv" },
};

function response(
  extra: Partial<ClassificationSuggestionsResponse> = {},
): ClassificationSuggestionsResponse {
  return {
    model: "vehicle_type",
    classes: ["van"],
    jev: {
      enabled: false,
      configured: false,
      used_today: 0,
      daily_request_limit: 200,
    },
    suggestions: { a: DRAFT, b: { ...DRAFT, suggestion: null } },
    ...extra,
  };
}

function emptyReport(extra: Partial<SuggestionReport> = {}): SuggestionReport {
  return {
    model: "vehicle_type",
    total: 0,
    accepted: 0,
    rate: null,
    sources: {},
    classes: {},
    cameras: {},
    first_time: null,
    last_time: null,
    ...extra,
  };
}

function wrap(node: ReactNode) {
  return <MemoryRouter>{node}</MemoryRouter>;
}

function deferred() {
  let resolve: (value: boolean) => void = () => {};
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function openFileAll() {
  fireEvent.click(screen.getByTestId("file-all"));
  return screen.getByTestId("file-all-dialog");
}

function runFileAll(dialog: HTMLElement) {
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: /^classificationSuggestions\.fileAll:/,
    }),
  );
}

describe("SuggestionStatusBar", () => {
  beforeEach(() => {
    confirmCalls.length = 0;
    confirmImpl = (...args) => Promise.resolve(args[0] !== "fails");
    toastSuccess.mockReset();
    toastWarning.mockReset();
    toastError.mockReset();
    report = undefined;
    hintSeen = true;
    hintLoaded = true;
  });

  it("shows the how-it-works hint until it is dismissed", () => {
    hintSeen = false;
    render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response()}
          groups={GROUPS}
          onRefresh={vi.fn()}
        />,
      ),
    );
    const hint = screen.getByTestId("suggestion-hint");
    expect(hint).toHaveTextContent("classificationSuggestions.hint");
    fireEvent.click(screen.getByText("classificationSuggestions.hintDismiss"));
    expect(dismissHint).toHaveBeenCalledTimes(1);
  });

  it("waits for the stored hint flag before showing the hint", () => {
    hintSeen = false;
    hintLoaded = false;
    render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response()}
          groups={GROUPS}
          onRefresh={vi.fn()}
        />,
      ),
    );
    expect(screen.queryByTestId("suggestion-hint")).toBeNull();
    expect(screen.getByTestId("suggestion-status")).toBeInTheDocument();
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

  it("counts photos with a guess against every photo on the page", () => {
    render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response()}
          groups={GROUPS}
          onRefresh={vi.fn()}
        />,
      ),
    );
    const bar = screen.getByTestId("suggestion-status");
    expect(screen.getByTestId("suggestion-headline")).toHaveTextContent(
      'guessCount:{"count":2,"total":4}',
    );
    // The internals moved to the Stats page.
    expect(bar).not.toHaveTextContent("jev");
    expect(bar).not.toHaveTextContent("kept");
    expect(screen.queryByTestId("suggestion-omitted")).toBeNull();
  });

  it("keeps the last answer while the next one loads", () => {
    const { rerender } = render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response()}
          groups={GROUPS}
          onRefresh={vi.fn()}
        />,
      ),
    );
    rerender(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={undefined}
          groups={{ a: GROUPS.a }}
          onRefresh={vi.fn()}
        />,
      ),
    );
    expect(screen.getByTestId("suggestion-headline")).toHaveTextContent(
      'guessCount:{"count":2,"total":2}',
    );
  });

  it("says how many photos got an answer when the server capped the ids", () => {
    render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response({ omitted: 1 })}
          groups={GROUPS}
          onRefresh={vi.fn()}
        />,
      ),
    );
    expect(screen.getByTestId("suggestion-omitted")).toHaveTextContent(
      'omitted:{"shown":3,"total":4}',
    );
  });

  it("accepts every guess on the page after one confirmation", async () => {
    const onRefresh = vi.fn();
    const onFiling = vi.fn();
    const data = response({
      suggestions: { a: DRAFT, b: SUV, fails: DRAFT },
    });
    render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={data}
          groups={GROUPS}
          onRefresh={onRefresh}
          onFiling={onFiling}
        />,
      ),
    );

    expect(screen.getByTestId("file-all")).toHaveTextContent(
      'fileAll:{"count":3}',
    );
    const dialog = openFileAll();
    expect(dialog).toHaveTextContent('fileAllTitle:{"count":3}');
    expect(screen.getByTestId("file-all-preview")).toHaveTextContent(
      "van 2, suv 1",
    );
    // No tiny photos, so there is nothing to skip.
    expect(screen.queryByTestId("file-all-skip-tiny")).toBeNull();
    runFileAll(dialog);

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(confirmCalls).toEqual([
      ["a", ["a-1.webp", "a-2.webp"], DRAFT.suggestion, undefined, true],
      ["b", ["b-1.webp"], SUV.suggestion, undefined, true],
      ["fails", ["f-1.webp"], DRAFT.suggestion, undefined, true],
    ]);
    expect(toastWarning).toHaveBeenCalledWith(
      'classificationSuggestions.fileAllDone:{"count":2,"total":3}',
      { position: "top-center" },
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(onFiling).toHaveBeenLastCalledWith(false));
    expect(onFiling).toHaveBeenCalledWith(true);
  });

  it("shows progress on the button while it runs", async () => {
    const first = deferred();
    confirmImpl = () => first.promise;
    render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response({ suggestions: { a: DRAFT, b: DRAFT } })}
          groups={GROUPS}
          onRefresh={vi.fn()}
        />,
      ),
    );
    runFileAll(openFileAll());
    const button = await screen.findByText(
      'classificationSuggestions.fileAllProgress:{"done":0,"total":2}',
    );
    expect(button.closest("button")).toBeDisabled();
    await act(async () => first.resolve(true));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess).toHaveBeenCalledWith(
      'classificationSuggestions.fileAllDone:{"count":2,"total":2}',
      { position: "top-center" },
    );
  });

  it("says so when no guess could be accepted", async () => {
    confirmImpl = () => Promise.resolve(false);
    render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response()}
          groups={GROUPS}
          onRefresh={vi.fn()}
        />,
      ),
    );
    runFileAll(openFileAll());
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(
      'classificationSuggestions.fileAllFailed:{"count":1}',
      { position: "top-center" },
    );
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("stops quietly when the page goes away mid-run", async () => {
    const first = deferred();
    confirmImpl = () => first.promise;
    const onFiling = vi.fn();
    const { unmount } = render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response({ suggestions: { a: DRAFT, b: DRAFT } })}
          groups={GROUPS}
          onRefresh={vi.fn()}
          onFiling={onFiling}
        />,
      ),
    );
    runFileAll(openFileAll());
    await waitFor(() => expect(confirmCalls).toHaveLength(1));
    unmount();
    await act(async () => first.resolve(true));
    expect(confirmCalls).toHaveLength(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
    expect(onFiling).toHaveBeenLastCalledWith(false);
  });

  it("skips guesses made only of tiny photos unless told otherwise (fork I50)", async () => {
    const data = response({
      suggestions: { a: DRAFT, b: SUV },
      too_small: { a: ["a-1.webp", "a-2.webp"] },
    });
    render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={data}
          groups={GROUPS}
          onRefresh={vi.fn()}
        />,
      ),
    );
    expect(screen.getByTestId("suggestion-small")).toHaveTextContent(
      'tinyPhotos:{"count":2}',
    );
    expect(screen.getByTestId("file-all")).toHaveTextContent(
      'fileAll:{"count":1}',
    );
    const dialog = openFileAll();
    const skip = screen.getByTestId("file-all-skip-tiny");
    expect(skip).toHaveAttribute("data-state", "checked");
    expect(dialog).toHaveTextContent('skipTiny:{"count":1}');
    expect(screen.getByTestId("file-all-preview")).toHaveTextContent("suv 1");

    fireEvent.click(skip);
    expect(dialog).toHaveTextContent('fileAllTitle:{"count":2}');
    expect(screen.getByTestId("file-all-preview")).toHaveTextContent(
      "suv 1, van 1",
    );
    fireEvent.click(skip);
    runFileAll(dialog);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(confirmCalls.map((call) => call[0])).toEqual(["b"]);
  });

  it("warns about lopsided classes and toggles unsure-first (fork I49, I51)", () => {
    report = emptyReport({
      dataset: {
        classes: { suv: 40, sedan: 10 },
        empty: [],
        largest: "suv",
        smallest: "sedan",
        ratio: 4,
        lopsided: true,
      },
    });
    const onUnsureFirst = vi.fn();
    render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response()}
          groups={GROUPS}
          onRefresh={vi.fn()}
          unsureFirst={false}
          onUnsureFirst={onUnsureFirst}
        />,
      ),
    );
    const lopsided = screen.getByTestId("suggestion-lopsided");
    expect(lopsided).toHaveTextContent(
      'lopsided:{"largest":"suv","smallest":"sedan","ratio":4}',
    );
    expect(lopsided.getAttribute("href")).toBe(
      "/classification/suggestions/vehicle_type",
    );
    expect(screen.getByTestId("suggestion-report-link")).toHaveAttribute(
      "href",
      "/classification/suggestions/vehicle_type",
    );
    const toggle = screen.getByTestId("train-order-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(onUnsureFirst).toHaveBeenCalledWith(true);
  });

  it("puts the switch, Stats and the notes in one menu on phones", async () => {
    report = emptyReport();
    const onUnsureFirst = vi.fn();
    render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response({ too_small: { a: ["a-1.webp", "a-2.webp"] } })}
          groups={GROUPS}
          onRefresh={vi.fn()}
          unsureFirst={false}
          onUnsureFirst={onUnsureFirst}
        />,
      ),
    );
    const more = screen.getByTestId("suggestion-more");
    expect(more).toHaveAttribute(
      "aria-label",
      "classificationSuggestions.more",
    );
    fireEvent.keyDown(more, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", {
        name: "classificationSuggestions.reportLink",
      }),
    ).toHaveAttribute("href", "/classification/suggestions/vehicle_type");
    expect(menu).toHaveTextContent('tinyPhotos:{"count":2}');
    fireEvent.click(screen.getByTestId("train-order-menu"));
    expect(onUnsureFirst).toHaveBeenCalledWith(true);
  });

  it("offers Train now once ten new photos are in (fork I54)", () => {
    report = emptyReport({
      training: {
        has_trained: true,
        last_training_date: null,
        current_images: 40,
        new_images: 12,
      },
    });
    const onTrain = vi.fn();
    const { rerender } = render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response()}
          groups={GROUPS}
          onRefresh={vi.fn()}
        />,
      ),
    );
    // Without the train action (training, or nothing changed) there is no bar.
    expect(screen.queryByTestId("suggestion-train-now")).toBeNull();
    rerender(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response()}
          groups={GROUPS}
          onRefresh={vi.fn()}
          onTrain={onTrain}
        />,
      ),
    );
    const train = screen.getByTestId("suggestion-train-now");
    expect(train).toHaveTextContent('trainNow:{"count":12}');
    fireEvent.click(train);
    expect(onTrain).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("suggestion-train-now")).toBeNull();
  });

  it("holds Train now below ten new photos", () => {
    report = emptyReport({
      training: {
        has_trained: true,
        last_training_date: null,
        current_images: 40,
        new_images: 9,
      },
    });
    render(
      wrap(
        <SuggestionStatusBar
          modelName="vehicle_type"
          data={response()}
          groups={GROUPS}
          onRefresh={vi.fn()}
          onTrain={vi.fn()}
        />,
      ),
    );
    expect(screen.queryByTestId("suggestion-train-now")).toBeNull();
  });
});
