import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { EventSuggestion } from "@/lib/fork/classification-suggestions";
import SuggestionBadge from "./SuggestionBadge";

const axiosPost = vi.fn<(url: string, body: unknown) => Promise<unknown>>();
const toastSuccess = vi.fn<(...args: unknown[]) => void>();
const toastError = vi.fn<(...args: unknown[]) => void>();

vi.mock("axios", () => ({
  default: { post: (url: string, body: unknown) => axiosPost(url, body) },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const JEV_ENTRY: EventSuggestion = {
  text: { category: "van", source: "text", score: null, evidence: "a van" },
  jev: { category: "van", source: "jev", score: 0.97, evidence: "" },
  jev_status: "answered",
  suggestion: {
    category: "van",
    source: "jev",
    score: 0.97,
    evidence: "a van",
  },
  conflict: false,
};

function renderBadge(entry: EventSuggestion | undefined, onRefresh = vi.fn()) {
  render(
    <TooltipProvider>
      <SuggestionBadge
        modelName="vehicle_type"
        eventId="evt-1"
        files={["a.webp", "b.webp"]}
        entry={entry}
        onRefresh={onRefresh}
      />
    </TooltipProvider>,
  );
  return onRefresh;
}

describe("SuggestionBadge", () => {
  beforeEach(() => {
    axiosPost.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("renders nothing without a draft", () => {
    renderBadge(undefined);
    expect(screen.queryByTestId("suggestion-badge")).toBeNull();
    renderBadge({ ...JEV_ENTRY, suggestion: null, jev: null });
    expect(screen.queryByTestId("suggestion-badge")).toBeNull();
    expect(screen.queryByTestId("suggestion-conflict")).toBeNull();
  });

  it("shows the class and score, and confirms every file of the event", async () => {
    axiosPost.mockResolvedValue({ data: { success: true } });
    const onRefresh = renderBadge(JEV_ENTRY);

    const badge = screen.getByTestId("suggestion-badge");
    expect(badge).toHaveTextContent("van");
    expect(badge).toHaveTextContent("97%");

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(axiosPost).toHaveBeenCalledWith(
      "classification/vehicle_type/suggestions/confirm",
      {
        event_id: "evt-1",
        category: "van",
        training_files: ["a.webp", "b.webp"],
        source: "jev",
        score: 0.97,
        suggested_category: "van",
      },
    );
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("reports a failed confirm and leaves the grid alone", async () => {
    axiosPost.mockRejectedValue(new Error("nope"));
    const onRefresh = renderBadge(JEV_ENTRY);

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("marks a disagreement instead of picking a side", () => {
    renderBadge({
      ...JEV_ENTRY,
      jev: { category: "suv", source: "jev", score: 0.95, evidence: "" },
      suggestion: null,
      conflict: true,
    });
    expect(screen.getByTestId("suggestion-conflict")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the draft and flags an event whose every crop is tiny (fork I50)", () => {
    render(
      <TooltipProvider>
        <SuggestionBadge
          modelName="vehicle_type"
          eventId="evt-1"
          files={["a.webp", "b.webp"]}
          entry={JEV_ENTRY}
          onRefresh={vi.fn()}
          tooSmall={["a.webp", "b.webp"]}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("suggestion-too-small")).toBeInTheDocument();
    expect(screen.getByTestId("suggestion-badge")).toHaveTextContent("van");
  });

  it("files every crop on confirm, tiny ones included (fork I50)", async () => {
    axiosPost.mockResolvedValue({});
    render(
      <TooltipProvider>
        <SuggestionBadge
          modelName="vehicle_type"
          eventId="evt-1"
          files={["a.webp", "b.webp"]}
          entry={JEV_ENTRY}
          onRefresh={vi.fn()}
          tooSmall={["b.webp"]}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1));
    expect(axiosPost.mock.calls[0]?.[1]).toMatchObject({
      training_files: ["a.webp", "b.webp"],
    });
    expect(screen.queryByTestId("suggestion-too-small")).toBeNull();
  });
});
