import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import AudioReviewResults from "../AudioReviewResults";

const response = vi.hoisted(() => ({ data: {} as unknown }));
vi.mock("swr", () => ({
  default: () => ({ data: response.data, mutate: vi.fn() }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
beforeEach(() => {
  response.data = {
    status: "available",
    chunks: [
      {
        id: "review:0",
        start: 100,
        end: 130,
        state: "second_opinion",
        result: {
          transcript: "<script>private original</script>",
          translation: "English text",
          sounds: [{ label: "speech", similarity: 0.2 }],
          stages: { sounds: { status: "failed" } },
          large_second_opinion: { transcript: "Alternate words" },
        },
      },
    ],
  };
});
it("preserves original and translation, labels partial output, and seeks the chunk", () => {
  const onSeek = vi.fn();
  const { container } = render(
    <AudioReviewResults reviewId="review" onSeek={onSeek} />,
  );
  expect(screen.getByText("<script>private original</script>")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("English text")).toBeTruthy();
  expect(screen.getByText("audioAnalysis.partial")).toBeTruthy();
  expect(screen.getByText("audioAnalysis.deferred")).toBeTruthy();
  expect(screen.getByText("audioAnalysis.secondOpinion")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "audioAnalysis.play" }));
  expect(onSeek).toHaveBeenCalledWith(100);
});
it("shows a failed chunk rather than an unexplained playback button", () => {
  response.data = {
    status: "available",
    chunks: [
      { id: "review:1", start: 100, end: 130, state: "failed", result: null },
    ],
  };
  render(<AudioReviewResults reviewId="review" onSeek={vi.fn()} />);
  expect(screen.getByText("audioAnalysis.states.failed")).toBeTruthy();
});
