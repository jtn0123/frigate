import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InProgressPreview } from "../ScrubbablePreview";

vi.mock("@/api", () => ({ useApiHost: () => "/" }));
const frames = vi.hoisted(() => ({
  data: ["first", "middle", "last"] as string[],
}));
vi.mock("swr", () => ({ default: () => frames }));
beforeEach(() => {
  frames.data = ["first", "middle", "last"];
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-device-detect", () => ({
  isMobile: false,
  isSafari: false,
  isFirefox: false,
}));

afterEach(() => vi.useRealTimers());

function setup() {
  const { container } = render(
    <InProgressPreview
      defaultImageUrl="/thumbnail.webp"
      camera="front_door"
      startTime={100}
      endTime={103}
      timeRange={{ after: 0, before: 200 }}
      setReviewed={vi.fn()}
      setIgnoreClick={vi.fn()}
      isPlayingBack={vi.fn()}
      windowVisible
    />,
  );
  const track = (container.firstElementChild!.lastElementChild ??
    container.firstElementChild)!;
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    left: 100,
    width: 100,
  } as DOMRect);
  Object.defineProperty(track, "clientWidth", { value: 100 });
  return { track, image: screen.getByRole("img") };
}

describe("in-progress preview scrubbing", () => {
  it.each([200, 225])("keeps a valid last frame at x=%s", (clientX) => {
    const { track, image } = setup();
    fireEvent.mouseMove(track, { clientX });
    expect(image).toHaveAttribute("src", "/api/preview/last/thumbnail.webp");
  });

  it("keeps a valid first frame left of the track", () => {
    const { track, image } = setup();
    fireEvent.mouseMove(track, { clientX: 50 });
    expect(image).toHaveAttribute("src", "/api/preview/first/thumbnail.webp");
  });

  it("resumes from the first frame after leaving the left edge", async () => {
    vi.useFakeTimers();
    const { track, image } = setup();
    fireEvent.mouseMove(track, { clientX: 100 });
    fireEvent.mouseLeave(track, { clientX: 90 });
    await act(() => vi.advanceTimersByTime(1000));
    expect(image).toHaveAttribute("src", "/api/preview/first/thumbnail.webp");
    fireEvent.load(image);
    await act(() => vi.advanceTimersByTime(200));
    expect(image).toHaveAttribute("src", "/api/preview/middle/thumbnail.webp");
  });
});

describe("preview fallback", () => {
  it("keeps the thumbnail when no frames exist", () => {
    frames.data = [];
    setup();
    expect(screen.getByRole("img")).toHaveAttribute("src", "/thumbnail.webp");
  });

  it("restores the thumbnail when a frame fails to load", () => {
    const { image } = setup();
    fireEvent.error(image);
    expect(image).toHaveAttribute("src", "/thumbnail.webp");
  });
});

it("resumes a loaded frame after scrubbing without requiring another load event", async () => {
  vi.useFakeTimers();
  const { track, image } = setup();
  fireEvent.load(image);
  fireEvent.mouseMove(track, { clientX: 150 });
  fireEvent.load(image);
  await act(() => vi.advanceTimersByTime(250));
  expect(image).toHaveAttribute("src", "/api/preview/middle/thumbnail.webp");
  fireEvent.mouseLeave(track, { clientX: 150 });
  await act(() => vi.advanceTimersByTime(1000));
  await act(() => vi.advanceTimersByTime(200));
  expect(image).toHaveAttribute("src", "/api/preview/last/thumbnail.webp");
});
