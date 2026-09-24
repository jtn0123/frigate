import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewSegment } from "@/types/review";
import ReviewActionGroup from "./ReviewActionGroup";

const canGenerateDescription = vi.fn<(review: ReviewSegment) => boolean>();
const generateDescription = vi.fn<(review: ReviewSegment) => void>();

vi.mock("react-device-detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-device-detect")>()),
  isDesktop: true,
  isMobile: false,
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-is-admin", () => ({ useIsAdmin: () => true }));
vi.mock("@/hooks/use-review-descriptions", () => ({
  useReviewDescriptions: () => ({
    canGenerateDescription,
    generateDescription,
  }),
}));
vi.mock("../overlay/MultiExportDialog", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

function review(id: string): ReviewSegment {
  return {
    id,
    camera: "front_door",
    start_time: 100,
    end_time: 130,
    severity: "alert",
    has_been_reviewed: false,
  } as ReviewSegment;
}

function renderGroup(selectedReviews: ReviewSegment[]) {
  const setSelectedReviews = vi.fn();
  render(
    <ReviewActionGroup
      selectedReviews={selectedReviews}
      setSelectedReviews={setSelectedReviews}
      onExport={vi.fn()}
      pullLatestData={vi.fn()}
    />,
  );
  return { setSelectedReviews };
}

const generateButton = () =>
  screen.queryByRole("button", {
    name: "recording.button.generateDescription",
  });

describe("ReviewActionGroup generate description", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canGenerateDescription.mockReturnValue(true);
  });

  it("sends a single eligible item and clears the selection", () => {
    const item = review("r1");
    const { setSelectedReviews } = renderGroup([item]);

    expect(canGenerateDescription).toHaveBeenCalledWith(item);
    const button = generateButton();
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent("recording.button.generateDescription");

    fireEvent.click(button!);

    expect(generateDescription).toHaveBeenCalledWith(item);
    expect(setSelectedReviews).toHaveBeenCalledWith([]);
  });

  it("hides the action when the item is not eligible", () => {
    canGenerateDescription.mockReturnValue(false);
    renderGroup([review("r1")]);

    expect(generateButton()).not.toBeInTheDocument();
  });

  it("hides the action for a multi item selection", () => {
    renderGroup([review("r1"), review("r2")]);

    expect(generateButton()).not.toBeInTheDocument();
    expect(canGenerateDescription).not.toHaveBeenCalled();
  });
});
