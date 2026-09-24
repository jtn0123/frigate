import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ExploreSuggestion from "./ExploreSuggestion";
import type {
  EventModelSuggestion,
  EventSuggestionsResponse,
} from "@/lib/fork/classification-suggestions";

let data: EventSuggestionsResponse | undefined;
const mutate = vi.fn();
const confirm = vi.fn(async () => true);
let isAdmin = true;

vi.mock("@/hooks/fork/use-event-suggestions", () => ({
  useEventSuggestions: (eventId: string | null) => ({
    data: eventId ? data : undefined,
    mutate,
  }),
}));
vi.mock("@/hooks/fork/use-confirm-suggestion", () => ({
  useConfirmSuggestion: () => confirm,
}));
vi.mock("@/hooks/use-is-admin", () => ({
  useIsAdmin: () => isAdmin,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

function row(overrides: Partial<EventModelSuggestion>): EventModelSuggestion {
  return {
    model: "vehicle_type",
    classes: ["sedan", "suv"],
    suggestion: {
      text: null,
      jev: null,
      jev_status: "disabled",
      suggestion: {
        category: "suv",
        source: "jev",
        score: 0.97,
        evidence: "A white SUV.",
      },
      conflict: false,
    },
    training_files: ["evt-1-1.0-unknown-0.0.webp"],
    model_said: null,
    filed: null,
    ...overrides,
  };
}

describe("ExploreSuggestion", () => {
  beforeEach(() => {
    data = undefined;
    isAdmin = true;
    mutate.mockClear();
    confirm.mockClear();
  });

  it("renders nothing without a draft or a filed class", () => {
    data = {
      event_id: "evt-1",
      models: [
        row({
          suggestion: {
            text: null,
            jev: null,
            jev_status: "unknown",
            suggestion: null,
            conflict: false,
          },
        }),
      ],
    };
    render(<ExploreSuggestion eventId="evt-1" hasModels />);
    expect(screen.queryByTestId("explore-suggestion")).toBeNull();
  });

  it("shows the draft with its source and files it in one click", async () => {
    data = { event_id: "evt-1", models: [row({})] };
    render(<ExploreSuggestion eventId="evt-1" hasModels />);
    const box = screen.getByTestId("explore-suggestion");
    expect(box).toHaveTextContent(
      'suggested:{"model":"vehicle_type","category":"suv"}',
    );
    expect(box).toHaveTextContent('viaJev:{"percent":97}');
    fireEvent.click(
      screen.getByRole("button", { name: "classificationSuggestions.file" }),
    );
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(
      "evt-1",
      ["evt-1-1.0-unknown-0.0.webp"],
      expect.objectContaining({ category: "suv" }),
    );
  });

  it("says when nothing is left to file and when the model disagrees", () => {
    data = {
      event_id: "evt-1",
      models: [row({ training_files: [], model_said: "sedan" })],
    };
    render(<ExploreSuggestion eventId="evt-1" hasModels />);
    const box = screen.getByTestId("explore-suggestion");
    expect(box).toHaveTextContent("classificationSuggestions.noTrainImages");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("explore-model-said")).toHaveTextContent(
      'modelSaid:{"category":"sedan"}',
    );
    expect(screen.getByTestId("explore-model-said").className).toContain(
      "text-warning",
    );
  });

  it("shows what the event was filed as, including auto-filed", () => {
    data = {
      event_id: "evt-1",
      models: [
        row({ filed: { category: "suv", auto: true }, model_said: "suv" }),
      ],
    };
    render(<ExploreSuggestion eventId="evt-1" hasModels />);
    const box = screen.getByTestId("explore-suggestion");
    expect(box).toHaveTextContent(
      'filedAs:{"model":"vehicle_type","category":"suv"}',
    );
    expect(box).toHaveTextContent("classificationSuggestions.filedAuto");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("explore-model-said").className).not.toContain(
      "text-warning",
    );
  });

  it("asks nothing for viewers or without custom models", () => {
    data = { event_id: "evt-1", models: [row({})] };
    isAdmin = false;
    const { unmount } = render(<ExploreSuggestion eventId="evt-1" hasModels />);
    expect(screen.queryByTestId("explore-suggestion")).toBeNull();
    unmount();
    isAdmin = true;
    render(<ExploreSuggestion eventId="evt-1" hasModels={false} />);
    expect(screen.queryByTestId("explore-suggestion")).toBeNull();
  });
});
