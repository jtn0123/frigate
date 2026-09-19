import { createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReviewTimeline } from "../ReviewTimeline";

vi.mock("@/hooks/use-draggable-element", () => ({
  default: () => ({
    handleMouseDown: vi.fn(),
    handleMouseUp: vi.fn(),
    handleMouseMove: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-timeline-utils", () => ({
  useTimelineUtils: () => ({
    alignStartDateToTimeline: (time: number) => time,
    alignEndDateToTimeline: (time: number) => time,
    segmentHeight: 8,
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const zoomLevels = [
  { segmentDuration: 60, timestampSpread: 15 },
  { segmentDuration: 30, timestampSpread: 5 },
  { segmentDuration: 10, timestampSpread: 1 },
];

function renderTimeline(onZoomChange = vi.fn(), currentZoomLevel = 1) {
  const timelineRef = createRef<HTMLDivElement>();
  render(
    <TooltipProvider>
      <ReviewTimeline
        timelineRef={timelineRef}
        contentRef={createRef()}
        segmentDuration={30}
        timelineDuration={100}
        timelineStartAligned={200}
        showHandlebar={false}
        showExportHandles={false}
        dense={false}
        segments={[]}
        scrollToSegment={vi.fn()}
        isZooming={false}
        zoomDirection="in"
        onZoomChange={onZoomChange}
        possibleZoomLevels={zoomLevels}
        currentZoomLevel={currentZoomLevel}
      >
        <div />
      </ReviewTimeline>
    </TooltipProvider>,
  );
  return { timelineRef, onZoomChange };
}

describe("timeline zoom controls (UI106)", () => {
  it("groups both named zoom buttons in a bar above the rail on desktop", () => {
    const { timelineRef } = renderTimeline();
    const group = screen.getByRole("group", {
      name: "timelineAccessibility.zoom",
    });
    expect(group.className).toContain("top-0");
    expect(group.className).not.toContain("bottom-");
    expect(within(group).getByRole("button", { name: "zoomOut" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "zoomIn" })).toBeTruthy();
    // the scrolling rail starts below the bar instead of running under it
    expect(timelineRef.current?.className).toContain("mt-12");
    expect(timelineRef.current?.className).toContain("h-[calc(100%-3rem)]");
  });

  it("still steps one zoom level per click", () => {
    const { onZoomChange } = renderTimeline();
    fireEvent.click(screen.getByRole("button", { name: "zoomOut" }));
    expect(onZoomChange).toHaveBeenLastCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: "zoomIn" }));
    expect(onZoomChange).toHaveBeenLastCalledWith(2);
  });

  it("disables the button at either end of the zoom range", () => {
    renderTimeline(vi.fn(), 0);
    expect(
      (screen.getByRole("button", { name: "zoomOut" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps the rail full height when there is nothing to zoom", () => {
    const timelineRef = createRef<HTMLDivElement>();
    render(
      <ReviewTimeline
        timelineRef={timelineRef}
        contentRef={createRef()}
        segmentDuration={30}
        timelineDuration={100}
        timelineStartAligned={200}
        showHandlebar={false}
        showExportHandles={false}
        dense={false}
        segments={[]}
        scrollToSegment={vi.fn()}
        isZooming={false}
        zoomDirection="in"
      >
        <div />
      </ReviewTimeline>,
    );
    expect(screen.queryByRole("group")).toBeNull();
    expect(timelineRef.current?.className).not.toContain("mt-12");
  });
});
