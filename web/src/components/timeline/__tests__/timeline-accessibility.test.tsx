import { createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewTimeline } from "../ReviewTimeline";
import { SummaryTimeline } from "../SummaryTimeline";

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
vi.mock("@/fork/flags", () => ({ isForkEnabled: () => false }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../SummarySegment", () => ({ SummarySegment: () => null }));

function Timeline() {
  const [time, setTime] = useState(150);
  const [start, setStart] = useState(120);
  const [end, setEnd] = useState(180);
  return (
    <ReviewTimeline
      timelineRef={createRef()}
      contentRef={createRef()}
      segmentDuration={10}
      timelineDuration={100}
      timelineStartAligned={200}
      showHandlebar
      showExportHandles
      handlebarTime={time}
      setHandlebarTime={setTime}
      exportStartTime={start}
      setExportStartTime={setStart}
      exportEndTime={end}
      setExportEndTime={setEnd}
      dense={false}
      segments={[]}
      scrollToSegment={vi.fn()}
      isZooming={false}
      zoomDirection="in"
    >
      <div />
    </ReviewTimeline>
  );
}

describe("timeline keyboard access", () => {
  it("seeks and clamps with the feature flag off, publishing the new range value", () => {
    render(<Timeline />);
    const handle = screen.getByRole("slider", {
      name: "timelineScrubber.handlebar",
    });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle.getAttribute("aria-valuenow")).toBe("160");
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(handle.getAttribute("aria-valuenow")).toBe("100");
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("200");
  });

  it("keeps export handles ordered when moved by keyboard", () => {
    render(<Timeline />);
    const start = screen.getByRole("slider", {
      name: "timelineAccessibility.exportStart",
    });
    const end = screen.getByRole("slider", {
      name: "timelineAccessibility.exportEnd",
    });
    fireEvent.keyDown(start, { key: "End" });
    expect(start.getAttribute("aria-valuenow")).toBe("180");
    fireEvent.keyDown(end, { key: "Home" });
    expect(end.getAttribute("aria-valuenow")).toBe("180");
    fireEvent.keyDown(start, { key: "Home" });
    expect(start.getAttribute("aria-valuenow")).toBe("100");
    expect(end.getAttribute("aria-valuemin")).toBe("100");
  });

  it("scrolls the overview by keyboard and updates its accessible position", () => {
    const content = document.createElement("div");
    Object.defineProperties(content, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 500 },
    });
    content.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === "object") content.scrollTop = options.top ?? 0;
      content.dispatchEvent(new Event("scroll"));
    });
    render(
      <SummaryTimeline
        reviewTimelineRef={{ current: content }}
        timelineStart={200}
        timelineEnd={100}
        segmentDuration={10}
        events={[]}
        severityType="alert"
      />,
    );
    const overview = screen.getByRole("scrollbar", {
      name: "timelineAccessibility.overview",
    });
    expect(overview.getAttribute("aria-controls")).toBe(content.id);
    fireEvent.keyDown(overview, { key: "ArrowDown" });
    expect(content.scrollTop).toBe(40);
    expect(overview.getAttribute("aria-valuenow")).toBe("10");
    fireEvent.keyDown(overview, { key: "End" });
    expect(content.scrollTop).toBe(400);
    expect(overview.getAttribute("aria-valuenow")).toBe("100");
  });
});
