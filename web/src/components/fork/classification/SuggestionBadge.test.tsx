import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSuggestion } from "@/lib/fork/classification-suggestions";
import SuggestionBadge from "./SuggestionBadge";

const axiosPost = vi.fn<(url: string, body: unknown) => Promise<unknown>>();
const toastSuccess = vi.fn<(...args: unknown[]) => void>();
const toastError = vi.fn<(...args: unknown[]) => void>();

vi.mock("axios", () => ({
  default: {
    post: (url: string, body: unknown) => axiosPost(url, body),
    isAxiosError: () => false,
  },
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

function renderBadge(
  entry: EventSuggestion | undefined,
  onRefresh = vi.fn(),
  extra: { tooSmall?: string[]; disabled?: boolean; classes?: string[] } = {},
) {
  render(
    <SuggestionBadge
      modelName="vehicle_type"
      eventId="evt-1"
      files={["a.webp", "b.webp"]}
      entry={entry}
      onRefresh={onRefresh}
      {...extra}
    />,
  );
  return onRefresh;
}

const accept = () => screen.getByTestId("suggestion-accept");

/** The picker's class button at `index`, failing loudly if it is missing. */
function pickAt(index: number): HTMLElement {
  const buttons = Array.from(
    screen.getByTestId("suggestion-picker").querySelectorAll("button"),
  );
  const button = buttons.at(index);
  if (button === undefined) {
    throw new Error(`no class button at ${index}`);
  }
  return button;
}

describe("SuggestionBadge", () => {
  beforeEach(() => {
    axiosPost.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("renders nothing before the suggestions arrive", () => {
    renderBadge(undefined);
    expect(screen.queryByTestId("suggestion-badge")).toBeNull();
    expect(screen.queryByTestId("suggestion-blank")).toBeNull();
  });

  it("offers a class picker with the reason when there is no guess", async () => {
    axiosPost.mockResolvedValue({ data: { moved: ["x.webp"] } });
    const onRefresh = renderBadge(
      {
        text: null,
        jev: null,
        jev_status: "unknown",
        suggestion: null,
        conflict: false,
        maybe: null,
      },
      vi.fn(),
      { classes: ["sedan", "suv", "none"] },
    );
    expect(screen.queryByTestId("suggestion-accept")).toBeNull();
    fireEvent.click(
      screen.getByTestId("suggestion-blank").querySelector("button")!,
    );
    const why = await screen.findByTestId("suggestion-why");
    expect(why).toHaveTextContent("classificationSuggestions.noGuess.unclear");
    const picks = screen
      .getByTestId("suggestion-picker")
      .querySelectorAll("button");
    // "none" is not a class a person files into.
    expect(Array.from(picks).map((b) => b.textContent)).toEqual([
      "sedan",
      "suv",
    ]);
    fireEvent.click(pickAt(1));
    await waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1));
    expect(axiosPost.mock.calls[0]?.[1]).toEqual({
      event_id: "evt-1",
      category: "suv",
      training_files: ["a.webp", "b.webp"],
      source: null,
      score: null,
      suggested_category: null,
    });
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("shows a maybe first in the picker and never records it as the draft", async () => {
    axiosPost.mockResolvedValue({ data: { moved: [] } });
    renderBadge(
      {
        text: null,
        jev: null,
        jev_status: "unknown",
        suggestion: null,
        conflict: false,
        maybe: { category: "pickup", source: "jev", score: 0.8, evidence: "" },
      },
      vi.fn(),
      { classes: ["sedan", "pickup"] },
    );
    const maybe = screen.getByTestId("suggestion-maybe");
    expect(maybe).toHaveTextContent("classificationSuggestions.maybeLabel");
    expect(screen.queryByTestId("suggestion-accept")).toBeNull();
    fireEvent.click(maybe.querySelector("button")!);
    const why = await screen.findByTestId("suggestion-why");
    expect(why).toHaveTextContent("classificationSuggestions.maybeWhy");
    expect(pickAt(0)).toHaveTextContent("pickup");
    fireEvent.click(pickAt(0));
    await waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1));
    expect(axiosPost.mock.calls[0]?.[1]).toMatchObject({
      category: "pickup",
      suggested_category: null,
    });
  });

  it("lets a person override a sure guess from its popover", async () => {
    axiosPost.mockResolvedValue({ data: { moved: [] } });
    renderBadge(JEV_ENTRY, vi.fn(), { classes: ["van", "suv"] });
    fireEvent.click(screen.getByRole("button", { name: /why/ }));
    await screen.findByTestId("suggestion-picker");
    expect(pickAt(0)).toHaveTextContent("van");
    fireEvent.click(pickAt(1));
    await waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1));
    expect(axiosPost.mock.calls[0]?.[1]).toMatchObject({
      category: "suv",
      suggested_category: "van",
      source: "jev",
    });
  });

  it("shows the class with a confidence dot, and confirms every file of the event", async () => {
    axiosPost.mockResolvedValue({ data: { success: true } });
    const onRefresh = renderBadge(JEV_ENTRY);

    const badge = screen.getByTestId("suggestion-badge");
    expect(badge).toHaveTextContent("van?");
    // The percent lives in the popover; the pill shows a colored dot.
    expect(badge).not.toHaveTextContent("97%");
    expect(screen.getByTestId("suggestion-confidence")).toHaveAttribute(
      "title",
      "classificationSuggestions.confidenceHigh",
    );

    fireEvent.click(accept());

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

  it("explains the draft in a popover with the matched words marked", () => {
    renderBadge(JEV_ENTRY);
    expect(screen.queryByTestId("suggestion-why")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: 'classificationSuggestions.why:{"category":"van"}',
      }),
    );

    const why = screen.getByTestId("suggestion-why");
    expect(why).toHaveTextContent(
      'classificationSuggestions.scoreLine:{"category":"van","score":97}',
    );
    expect(why).toHaveTextContent("classificationSuggestions.fromJev");
    expect(why).toHaveTextContent("a van");
    expect(why.querySelector("mark")).toHaveTextContent("van");
  });

  it("shows underscores as spaces and colors the dot by score", () => {
    renderBadge({
      ...JEV_ENTRY,
      suggestion: {
        category: "delivery_truck",
        source: "jev",
        score: 0.7,
        evidence: "",
      },
    });
    expect(screen.getByTestId("suggestion-badge")).toHaveTextContent(
      "delivery truck?",
    );
    expect(screen.getByTitle("delivery truck")).toBeInTheDocument();
    expect(screen.getByTestId("suggestion-confidence")).toHaveAttribute(
      "title",
      "classificationSuggestions.confidenceMedium",
    );
  });

  it("leaves the dot off a text match, which has no score", () => {
    renderBadge({
      ...JEV_ENTRY,
      suggestion: {
        category: "van",
        source: "text",
        score: null,
        evidence: "",
      },
    });
    expect(screen.queryByTestId("suggestion-confidence")).toBeNull();
  });

  it("reports a failed confirm and keeps the card", async () => {
    axiosPost.mockRejectedValue(new Error("nope"));
    renderBadge(JEV_ENTRY);

    fireEvent.click(accept());

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(accept()).toBeEnabled());
  });

  it("does not accept while the page is filing", () => {
    renderBadge(JEV_ENTRY, vi.fn(), { disabled: true });
    expect(accept()).toBeDisabled();
    fireEvent.click(accept());
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it("moves focus to the next card's check after an accept", async () => {
    axiosPost.mockResolvedValue({ data: {} });
    render(
      <div className="grid">
        <SuggestionBadge
          modelName="vehicle_type"
          eventId="evt-1"
          files={["a.webp"]}
          entry={JEV_ENTRY}
          onRefresh={vi.fn()}
        />
        <SuggestionBadge
          modelName="vehicle_type"
          eventId="evt-2"
          files={["b.webp"]}
          entry={JEV_ENTRY}
          onRefresh={vi.fn()}
        />
      </div>,
    );
    const [first, second] = screen.getAllByTestId("suggestion-accept");
    fireEvent.click(first!);
    await waitFor(() => expect(second).toHaveFocus());
  });

  it("marks a disagreement with a button that explains it", () => {
    renderBadge({
      ...JEV_ENTRY,
      jev: { category: "suv", source: "jev", score: 0.95, evidence: "" },
      suggestion: null,
      conflict: true,
    });
    expect(screen.getByTestId("suggestion-conflict")).toBeInTheDocument();
    expect(screen.queryByTestId("suggestion-accept")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: 'classificationSuggestions.conflictWhy:{"text":"van","jev":"suv"}',
      }),
    );
    expect(
      screen.getByText(
        'classificationSuggestions.conflict:{"text":"van","jev":"suv"}',
      ),
    ).toBeInTheDocument();
  });

  it("keeps the draft and flags an event whose every crop is tiny (fork I50)", () => {
    renderBadge(JEV_ENTRY, vi.fn(), { tooSmall: ["a.webp", "b.webp"] });
    expect(screen.getByTestId("suggestion-too-small")).toHaveClass(
      "text-amber-400",
    );
    expect(screen.getByTestId("suggestion-badge")).toHaveTextContent("van");

    fireEvent.click(
      screen.getByRole("button", {
        name: 'classificationSuggestions.why:{"category":"van"}',
      }),
    );
    expect(screen.getByTestId("suggestion-why")).toHaveTextContent(
      "classificationSuggestions.tooSmall",
    );
  });

  it("files every crop on confirm, tiny ones included (fork I50)", async () => {
    axiosPost.mockResolvedValue({ data: {} });
    renderBadge(JEV_ENTRY, vi.fn(), { tooSmall: ["b.webp"] });
    fireEvent.click(accept());
    await waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1));
    expect(axiosPost.mock.calls[0]?.[1]).toMatchObject({
      training_files: ["a.webp", "b.webp"],
    });
    expect(screen.queryByTestId("suggestion-too-small")).toBeNull();
  });
});
