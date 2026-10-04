import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Polygon } from "@/types/canvas";
import ZoneShapeFields from "./ZoneShapeFields";
import ZoneShapeBadge, { forkZoneIcon } from "./ZoneShapeBadge";
import MaskVsExclusionNote from "./MaskVsExclusionNote";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

const swr = vi.hoisted(() => ({
  data: undefined as unknown,
  config: { ui: { timezone: null } } as unknown,
  keys: [] as unknown[],
}));

vi.mock("swr", () => ({
  default: (key: unknown) => {
    if (key === "config") return { data: swr.config };
    swr.keys.push(key);
    return { data: swr.data };
  },
}));

afterEach(() => {
  vi.useRealTimers();
  swr.config = { ui: { timezone: null } };
});

/** The `after` of the newest crossing count request. */
function countedAfter(): number | undefined {
  const key = swr.keys.at(-1) as [string, { after: number }] | null;
  return key?.[1].after;
}

function zone(extra: Partial<Polygon> = {}): Polygon {
  return {
    typeIndex: 0,
    camera: "street",
    name: "walkway",
    type: "zone",
    objects: [],
    points: [
      [0, 0],
      [10, 0],
      [10, 10],
    ],
    distances: [],
    isFinished: true,
    color: [0, 128, 255],
    ...extra,
  };
}

function renderFields(polygon: Polygon) {
  const saved: Polygon[][] = [];
  const setPolygons: React.Dispatch<React.SetStateAction<Polygon[]>> = (
    next,
  ) => {
    if (Array.isArray(next)) saved.push(next);
  };
  render(
    <ZoneShapeFields
      polygons={[polygon]}
      setPolygons={setPolygons}
      activePolygonIndex={0}
    />,
  );
  return (): Polygon => {
    const polygon = saved.at(-1)?.[0];
    if (!polygon) throw new Error("nothing was saved");
    return polygon;
  };
}

describe("ZoneShapeFields", () => {
  it("offers the exclusion switch on an area", () => {
    const saved = renderFields(zone());
    expect(screen.queryByTestId("line-zone-hint")).toBeNull();
    expect(screen.queryByTestId("line-zone-alert-hint")).toBeNull();
    fireEvent.click(screen.getByTestId("zone-exclusion"));
    expect(saved().exclusion).toBe(true);
  });

  it("turns an area into a line that starts over", () => {
    const saved = renderFields(zone({ exclusion: true }));
    fireEvent.click(screen.getByTestId("zone-shape-line"));
    expect(saved()).toMatchObject({
      zoneType: "line",
      points: [],
      isFinished: false,
      exclusion: false,
    });
  });

  it("shows the line hint and direction choices on a line", () => {
    const saved = renderFields(
      zone({
        zoneType: "line",
        points: [
          [0, 0],
          [5, 5],
        ],
      }),
    );
    expect(screen.getByTestId("line-zone-hint")).toBeInTheDocument();
    expect(screen.getByTestId("line-zone-alert-hint")).toHaveTextContent(
      "lineZones.direction.alert",
    );
    expect(screen.queryByTestId("zone-exclusion")).toBeNull();
    expect(screen.getByTestId("line-direction-both")).toHaveAttribute(
      "data-state",
      "on",
    );
    fireEvent.click(screen.getByTestId("line-direction-b_to_a"));
    expect(saved().direction).toBe("b_to_a");
  });

  it("turns the direction icons the way the arrow on the line points", () => {
    // drawn down the frame, so side A is on the right and A to B points left
    renderFields(
      zone({
        zoneType: "line",
        points: [
          [40, 10],
          [40, 90],
        ],
      }),
    );
    for (const direction of ["both", "a_to_b", "b_to_a"]) {
      const icon = screen
        .getByTestId(`line-direction-${direction}`)
        .querySelector("svg");
      expect(icon).toHaveStyle({ transform: "rotate(180deg)" });
    }
  });

  it("keeps the direction icons as drawn before the line has both ends", () => {
    renderFields(zone({ zoneType: "line", points: [[40, 10]] }));
    const icon = screen
      .getByTestId("line-direction-a_to_b")
      .querySelector("svg");
    expect(icon?.getAttribute("style") ?? "").not.toContain("rotate");
  });

  it("turns a line back into an area", () => {
    const saved = renderFields(zone({ zoneType: "line" }));
    fireEvent.click(screen.getByTestId("zone-shape-polygon"));
    expect(saved().zoneType).toBe("polygon");
  });

  it("is not shown for masks", () => {
    renderFields(zone({ type: "object_mask" }));
    expect(screen.queryByTestId("zone-shape-fields")).toBeNull();
  });
});

describe("ZoneShapeBadge", () => {
  it("marks an exclusion zone", () => {
    render(<ZoneShapeBadge polygon={zone({ exclusion: true })} />);
    expect(screen.getByTestId("exclusion-badge-walkway")).toHaveTextContent(
      "lineZones.badge.exclusion",
    );
  });

  it("shows a line's direction and today's crossings", () => {
    swr.data = {
      after: 0,
      before: 1,
      lines: [
        {
          camera: "street",
          zone: "walkway",
          direction: "a_to_b",
          total: 7,
          labels: { person: 7 },
        },
      ],
    };
    swr.keys = [];
    render(
      <ZoneShapeBadge
        polygon={zone({ zoneType: "line", direction: "a_to_b" })}
      />,
    );
    expect(screen.getByText("lineZones.badge.a_to_b")).toBeInTheDocument();
    expect(screen.getByTestId("line-crossings-walkway")).toHaveTextContent(
      "lineZones.count:7",
    );
    const [path, params] = swr.keys[0] as [
      string,
      { camera: string; after: number },
    ];
    expect(path).toBe("fork/line_crossings");
    expect(params.camera).toBe("street");
    expect(params.after).toBeGreaterThan(0);
  });

  it("counts from midnight in the UI's time zone", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    // 20:00 UTC on Oct 2 is 05:00 on Oct 3 in Tokyo
    vi.setSystemTime(Date.UTC(2026, 9, 2, 20, 0, 0));
    swr.config = { ui: { timezone: "Asia/Tokyo" } };
    swr.keys = [];
    render(<ZoneShapeBadge polygon={zone({ zoneType: "line" })} />);
    expect(countedAfter()).toBe(Date.UTC(2026, 9, 2, 15, 0, 0) / 1000);
  });

  it("moves on to the new day when the page stays open past midnight", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    // ten seconds before midnight in Tokyo
    vi.setSystemTime(Date.UTC(2026, 9, 2, 14, 59, 50));
    swr.config = { ui: { timezone: "Asia/Tokyo" } };
    swr.keys = [];
    render(<ZoneShapeBadge polygon={zone({ zoneType: "line" })} />);
    expect(countedAfter()).toBe(Date.UTC(2026, 9, 1, 15, 0, 0) / 1000);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(countedAfter()).toBe(Date.UTC(2026, 9, 2, 15, 0, 0) / 1000);
  });

  it("waits for the config before counting", () => {
    swr.config = undefined;
    swr.keys = [];
    render(<ZoneShapeBadge polygon={zone({ zoneType: "line" })} />);
    expect(swr.keys[0]).toBeNull();
  });

  it("waits for a new line to be saved before counting", () => {
    swr.keys = [];
    render(<ZoneShapeBadge polygon={zone({ zoneType: "line", name: "" })} />);
    expect(swr.keys[0]).toBeNull();
    expect(screen.queryByTestId("line-crossings-")).toBeNull();
  });

  it("adds nothing to a plain zone or a mask", () => {
    const { container } = render(<ZoneShapeBadge polygon={zone()} />);
    render(
      <ZoneShapeBadge
        polygon={zone({ type: "motion_mask", exclusion: true })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("lineZones.badge.exclusion")).toBeNull();
  });

  it("gives a line its own icon", () => {
    expect(forkZoneIcon(zone({ zoneType: "line" }))).toBeDefined();
    expect(forkZoneIcon(zone())).toBeUndefined();
  });
});

describe("MaskVsExclusionNote", () => {
  it("explains a mask against an exclusion zone", () => {
    render(<MaskVsExclusionNote className="mt-2" />);
    expect(screen.getByTestId("mask-vs-exclusion")).toHaveClass("mt-2");
  });
});
