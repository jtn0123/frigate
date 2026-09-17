import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import axios from "axios";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReviewSegment } from "@/types/review";
import ReviewCard from "./ReviewCard";

vi.mock("react-device-detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-device-detect")>()),
  isDesktop: true,
  isMobile: false,
  isIOS: false,
  isSafari: false,
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));
vi.mock("axios", () => ({
  default: { post: vi.fn(() => Promise.resolve({ status: 200 })) },
}));

function review(): ReviewSegment {
  return {
    id: "review-1",
    camera: "front_door",
    start_time: 1767225600,
    end_time: 1767225630,
    severity: "alert",
    has_been_reviewed: false,
    thumb_path: "/media/frigate/clips/review/thumb-front_door-review-1.webp",
    data: {
      detections: [],
      objects: ["person"],
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
      audio: [],
    },
  } as ReviewSegment;
}

function renderCard(event: ReviewSegment) {
  const onClick = vi.fn();
  const view = render(
    <TooltipProvider>
      <ReviewCard event={event} onClick={onClick} />
    </TooltipProvider>,
  );
  // the parent re-renders on every playback tick with the same props
  const tick = () =>
    view.rerender(
      <TooltipProvider>
        <ReviewCard event={event} onClick={onClick} />
      </TooltipProvider>,
    );
  return { tick };
}

const card = () => screen.queryByRole("button", { name: "review.card.open" });

describe("ReviewCard context menu", () => {
  it("hides the card once it is deleted", async () => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200 });
    const { tick } = renderCard(review());

    fireEvent.contextMenu(card()!);
    fireEvent.click(await screen.findByText("button.delete"));
    fireEvent.click(
      await screen.findByRole("button", { name: "button.delete" }),
    );

    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith("reviews/delete", {
        ids: ["review-1"],
      }),
    );
    tick();
    await waitFor(() => expect(card()).not.toBeInTheDocument());
  });

  it("drops Mark as reviewed once the item is reviewed", async () => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200 });
    const { tick } = renderCard(review());

    fireEvent.contextMenu(card()!);
    fireEvent.click(await screen.findByText("recording.button.markAsReviewed"));
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith("reviews/viewed", {
        ids: ["review-1"],
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("recording.button.markAsReviewed"),
      ).not.toBeInTheDocument(),
    );
    tick();

    fireEvent.contextMenu(card()!);
    expect(await screen.findByText("button.delete")).toBeInTheDocument();
    expect(
      screen.queryByText("recording.button.markAsReviewed"),
    ).not.toBeInTheDocument();
  });
});
