import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ExploreSuggestion from "./ExploreSuggestion";
import type {
  EventModelSuggestion,
  EventSuggestionsResponse,
} from "@/lib/fork/classification-suggestions";

let data: EventSuggestionsResponse | undefined;
const mutate = vi.fn<() => Promise<unknown>>();
const mutateKey = vi.fn<(key: unknown) => Promise<unknown>>();
const axiosPost = vi.fn<(url: string, body: unknown) => Promise<unknown>>();
const toastSuccess = vi.fn<(...args: unknown[]) => void>();
const toastError = vi.fn<(...args: unknown[]) => void>();
let isAdmin = true;

vi.mock("@/hooks/fork/use-event-suggestions", () => ({
  useEventSuggestions: (eventId: string | null) => ({
    data: eventId ? data : undefined,
    mutate,
  }),
}));
vi.mock("@/hooks/use-is-admin", () => ({
  useIsAdmin: () => isAdmin,
}));
vi.mock("axios", () => ({
  default: {
    post: (url: string, body: unknown) => axiosPost(url, body),
    isAxiosError: (error: unknown) =>
      (error as { isAxiosError?: boolean } | null)?.isAxiosError === true,
  },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));
vi.mock("swr", () => ({
  mutate: (key: unknown) => mutateKey(key),
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

const ADD_NAME =
  'classificationSuggestions.fileAria:{"category":"suv","model":"Vehicle type"}';

function httpError(status: number, message?: string) {
  return {
    isAxiosError: true,
    response: { status, data: message ? { message } : {} },
  };
}

describe("ExploreSuggestion", () => {
  beforeEach(() => {
    data = undefined;
    isAdmin = true;
    mutate.mockReset();
    mutate.mockResolvedValue(undefined);
    mutateKey.mockReset();
    mutateKey.mockResolvedValue(undefined);
    axiosPost.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
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

  it("shows the guess under a readable model name and adds it in one click", async () => {
    data = { event_id: "evt-1", models: [row({})] };
    axiosPost.mockResolvedValue({ data: { success: true } });
    let finishRefresh: () => void = () => {};
    mutate.mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = () => resolve(undefined);
      }),
    );
    render(<ExploreSuggestion eventId="evt-1" hasModels />);
    const box = screen.getByTestId("explore-suggestion");
    expect(box).toHaveTextContent("Vehicle type");
    expect(box).not.toHaveTextContent("vehicle_type");
    expect(box).toHaveTextContent(
      'classificationSuggestions.suggested:{"category":"suv"}',
    );
    expect(box).toHaveTextContent('viaJev:{"percent":97}');
    const button = screen.getByRole("button", { name: ADD_NAME });
    expect(button).toHaveTextContent(
      'classificationSuggestions.file:{"category":"suv"}',
    );

    fireEvent.click(button);
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(axiosPost).toHaveBeenCalledWith(
      "classification/vehicle_type/suggestions/confirm",
      expect.objectContaining({
        event_id: "evt-1",
        category: "suv",
        training_files: ["evt-1-1.0-unknown-0.0.webp"],
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      'classificationSuggestions.addedToTraining:{"category":"suv","count":1}',
      expect.anything(),
    );
    expect(mutateKey).toHaveBeenCalledWith(
      "classification/vehicle_type/suggestions/report",
    );
    // Still busy until the refreshed answer arrives, so no double add.
    expect(button).toBeDisabled();
    finishRefresh();
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("treats an already accepted group as sorted and refreshes", async () => {
    data = { event_id: "evt-1", models: [row({})] };
    axiosPost.mockRejectedValue(httpError(404, "already accepted"));
    render(<ExploreSuggestion eventId="evt-1" hasModels />);
    fireEvent.click(screen.getByRole("button", { name: ADD_NAME }));
    await waitFor(() =>
      expect(screen.getByTestId("explore-already-sorted")).toHaveTextContent(
        "classificationSuggestions.noTrainImages",
      ),
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows the server's message on failure and still refreshes", async () => {
    data = { event_id: "evt-1", models: [row({})] };
    axiosPost.mockRejectedValue(httpError(404, "Model not found"));
    render(<ExploreSuggestion eventId="evt-1" hasModels />);
    fireEvent.click(screen.getByRole("button", { name: ADD_NAME }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(
      "classificationSuggestions.addFailed",
      expect.objectContaining({ description: "Model not found" }),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    // Any other 404 is a failure, not an already sorted group.
    expect(screen.queryByTestId("explore-already-sorted")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: ADD_NAME })).not.toBeDisabled(),
    );
  });

  it("names each Add button after its model", () => {
    data = {
      event_id: "evt-1",
      models: [row({}), row({ model: "car_color" })],
    };
    render(<ExploreSuggestion eventId="evt-1" hasModels />);
    expect(screen.getByRole("button", { name: ADD_NAME })).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: 'classificationSuggestions.fileAria:{"category":"suv","model":"Car color"}',
      }),
    ).toBeInTheDocument();
  });

  it("says when it is already sorted and what the model thinks, calmly", () => {
    data = {
      event_id: "evt-1",
      models: [row({ training_files: [], model_said: "sedan" })],
    };
    render(<ExploreSuggestion eventId="evt-1" hasModels />);
    const box = screen.getByTestId("explore-suggestion");
    expect(box).toHaveTextContent("classificationSuggestions.noTrainImages");
    expect(screen.queryByRole("button")).toBeNull();
    const said = screen.getByTestId("explore-model-said");
    expect(said).toHaveTextContent('modelSaid:{"category":"sedan"}');
    expect(said.className).not.toContain("text-warning");
    expect(said.querySelector("svg")).toBeNull();
  });

  it("shows what the event is in training as, including added automatically", () => {
    data = {
      event_id: "evt-1",
      models: [
        row({ filed: { category: "suv", auto: true }, model_said: "suv" }),
      ],
    };
    const { unmount } = render(<ExploreSuggestion eventId="evt-1" hasModels />);
    const box = screen.getByTestId("explore-suggestion");
    expect(box).toHaveTextContent(
      'classificationSuggestions.filedAsAuto:{"category":"suv"}',
    );
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    data = {
      event_id: "evt-1",
      models: [row({ filed: { category: "suv", auto: false } })],
    };
    render(<ExploreSuggestion eventId="evt-1" hasModels />);
    expect(screen.getByTestId("explore-suggestion")).toHaveTextContent(
      'classificationSuggestions.filedAs:{"category":"suv"}',
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
