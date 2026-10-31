import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReviewSegment } from "@/types/review";
import DetailStream from "../DetailStream";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("swr", () => ({
  default: (key: unknown) => ({
    data: key === "config" ? { ui: {} } : undefined,
    isValidating: false,
  }),
}));
vi.mock("@/context/detail-stream-context", () => ({
  useDetailStream: () => ({
    annotationOffset: 0,
    selectedObjectIds: [],
    setSelectedObjectIds: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-user-interaction", () => ({
  default: () => ({ userInteracting: false, setProgrammaticScroll: vi.fn() }),
}));
vi.mock("@/hooks/use-user-persistence", () => ({
  useUserPersistence: () => [false, vi.fn()],
}));
vi.mock("@/hooks/use-date-utils", () => ({ use24HourTime: () => true }));
vi.mock("scroll-into-view-if-needed", () => ({ default: vi.fn() }));
vi.mock("../AudioReviewResults", () => ({ default: () => null }));
vi.mock("@/components/overlay/detail/AnnotationOffsetSlider", () => ({
  default: () => null,
}));
vi.mock("@/components/overlay/dialog/FrigatePlusDialog", () => ({
  FrigatePlusDialog: () => null,
}));
vi.mock("@/lib/fork/event-summary", () => ({
  summaryFromReview: (review: ReviewSegment) => ({ reviewId: review.id }),
}));
vi.mock("@/components/fork/EventSummaryHeader", () => ({
  default: ({ reviewId }: { reviewId: string }) => (
    <div data-testid="summary-header">{reviewId}</div>
  ),
}));
vi.mock("@/components/fork/ShareClipButton", () => ({
  default: ({ eventId }: { eventId?: string }) => (
    <div data-testid="share-clip">{eventId}</div>
  ),
}));

function review(id: string, camera: string, start: number): ReviewSegment {
  return {
    id,
    camera,
    severity: "alert",
    start_time: start,
    end_time: start + 30,
    thumb_path: "",
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: [`${id}-event`],
      objects: ["person"],
      significant_motion_areas: [],
      zones: [],
    },
  };
}

function view(reviewItems: ReviewSegment[], currentTime: number) {
  return (
    <TooltipProvider>
      <DetailStream
        reviewItems={reviewItems}
        currentTime={currentTime}
        onSeek={vi.fn()}
      />
    </TooltipProvider>
  );
}

describe("DetailStream (fork UI155)", () => {
  it("moves the header and Share clip row to the new camera's items", () => {
    const { rerender } = render(view([review("front-1", "front", 100)], 110));
    expect(screen.getByTestId("summary-header")).toHaveTextContent("front-1");

    // the new camera has nothing at the playhead, so the nearest item wins
    rerender(view([review("back-1", "back", 5_000)], 110));
    expect(screen.getByTestId("summary-header")).toHaveTextContent("back-1");
    expect(screen.getByTestId("share-clip")).toHaveTextContent("back-1-event");
  });
});
