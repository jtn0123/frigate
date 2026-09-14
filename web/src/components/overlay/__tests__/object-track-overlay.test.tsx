import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import ObjectTrackOverlay from "../ObjectTrackOverlay";

// Box is [left, top, width, height] and path points are ground points
// (bottom-center of the box), all normalized 0-1. Times are seconds.
const mock = vi.hoisted(() => ({
  config: {
    cameras: {
      street: {
        onvif: { autotracking: { enabled_in_config: false } },
        zones: {},
      },
    },
    model: { colormap: { person: [0, 255, 0] } },
  },
  events: [] as unknown[],
  timeline: [] as unknown[],
}));

vi.mock("swr", () => ({
  default: (key: unknown) => {
    if (key === "config") return { data: mock.config };
    if (Array.isArray(key) && key[0] === "event_ids") {
      return { data: mock.events };
    }
    if (typeof key === "string" && key.startsWith("timeline?")) {
      return { data: mock.timeline };
    }
    return { data: undefined };
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/context/detail-stream-context", () => ({
  useDetailStream: () => ({
    annotationOffset: 0,
    selectedObjectIds: ["person-1"],
  }),
}));

const WIDTH = 1280;
const HEIGHT = 720;

function moment(timestamp: number, box: number[], classType = "visible") {
  return {
    camera: "street",
    timestamp,
    class_type: classType,
    source_id: "person-1",
    source: "tracked_object",
    data: { camera: "street", label: "person", box, zones: [] },
  };
}

function object(path: [number, number, number][]) {
  mock.events = [
    {
      id: "person-1",
      label: "person",
      camera: "street",
      start_time: 100,
      data: { path_data: path.map(([x, y, t]) => [[x, y], t]) },
    },
  ];
}

function renderAt(time: number) {
  return render(
    <TooltipProvider>
      <ObjectTrackOverlay
        camera="street"
        showBoundingBoxes
        currentTime={time}
        videoWidth={WIDTH}
        videoHeight={HEIGHT}
      />
    </TooltipProvider>,
  ).container;
}

describe("ObjectTrackOverlay", () => {
  beforeEach(() => {
    // Two recorded moments five seconds apart, as Frigate records a walk
    mock.timeline = [
      moment(100, [0.1, 0.2, 0.1, 0.3]),
      moment(105, [0.6, 0.2, 0.1, 0.3], "gone"),
    ];
  });

  it("draws the recorded box at a recorded moment", () => {
    object([]);
    const rect = renderAt(100).querySelector("rect");
    expect(rect).not.toBeNull();
    expect(Number(rect!.getAttribute("x"))).toBeCloseTo(0.1 * WIDTH);
  });

  it("keeps a box on the path between recorded moments", () => {
    object([
      [0.2, 0.5, 101],
      [0.4, 0.7, 102],
    ]);
    const rect = renderAt(101.5).querySelector("rect");
    expect(rect).not.toBeNull();
    // ground (0.3, 0.6), sized like the nearest recorded box
    expect(Number(rect!.getAttribute("x"))).toBeCloseTo(0.25 * WIDTH);
    expect(Number(rect!.getAttribute("y"))).toBeCloseTo(0.3 * HEIGHT);
    expect(Number(rect!.getAttribute("width"))).toBeCloseTo(0.1 * WIDTH);
  });

  it("draws no box when the path is too sparse to place it", () => {
    object([
      [0.15, 0.5, 100.2],
      [0.65, 0.5, 104.8],
    ]);
    expect(renderAt(102.5).querySelector("rect")).toBeNull();
  });

  it("hides a path pinned entirely to the bottom edge", () => {
    // A close-up: every box reaches the frame's bottom edge
    mock.timeline = [
      moment(100, [0.3, 0.2, 0.4, 0.8]),
      moment(130, [0.3, 0.15, 0.4, 0.85], "stationary"),
    ];
    object([
      [0.5, 1, 101],
      [0.5, 1, 110],
    ]);
    const svg = renderAt(120);
    expect(svg.querySelector("path")).toBeNull();
    expect(svg.querySelectorAll("circle")).toHaveLength(0);
  });

  it("fades the dots on the edge and keeps the rest", () => {
    object([
      [0.2, 0.5, 101],
      [0.3, 1, 102],
    ]);
    const svg = renderAt(110);
    expect(svg.querySelector("path")).not.toBeNull();
    const faded = [...svg.querySelectorAll("circle")].filter(
      (circle) => circle.getAttribute("opacity") === "0.35",
    );
    // the edge path point, not the ones above the edge
    expect(faded).toHaveLength(1);
  });
});
