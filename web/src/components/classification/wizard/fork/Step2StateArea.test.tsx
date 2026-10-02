import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseUrl } from "@/api/baseUrl";
import Step2StateArea, { type Step2FormData } from "../Step2StateArea";

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number; rotation: number };
type RectProps = {
  ref?: Ref<unknown>;
  x: number;
  y: number;
  width: number;
  height: number;
  dragBoundFunc: (pos: Point) => Point;
  onDragEnd: () => void;
  onTransformEnd: () => void;
};
type TransformerProps = {
  ref?: Ref<unknown>;
  boundBoxFunc: (oldBox: Box, newBox: Box) => Box;
};

const fixture = vi.hoisted(() => {
  const rectState = { x: 0, y: 0, width: 0, height: 0, scaleX: 1, scaleY: 1 };
  type Key = keyof typeof rectState;
  const accessor = (key: Key) => (value?: number) => {
    if (value !== undefined) {
      rectState[key] = value;
    }
    return rectState[key];
  };
  const transformerNodes: unknown[][] = [];
  const batchDraws: number[] = [];
  return {
    config: undefined as unknown,
    containerWidth: 1600,
    mobile: false,
    rectState,
    rectNode: {
      x: accessor("x"),
      y: accessor("y"),
      width: accessor("width"),
      height: accessor("height"),
      scaleX: accessor("scaleX"),
      scaleY: accessor("scaleY"),
    },
    transformerNodes,
    batchDraws,
    transformerNode: {
      nodes: (nodes: unknown[]) => {
        transformerNodes.push(nodes);
      },
      getLayer: () => ({
        batchDraw: () => {
          batchDraws.push(1);
        },
      }),
    },
    rectProps: undefined as RectProps | undefined,
    transformerProps: undefined as TransformerProps | undefined,
  };
});

function assignRef(ref: Ref<unknown> | undefined, value: unknown) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

vi.mock("swr", () => ({
  default: (key: string) => ({
    data: key === "config" ? fixture.config : undefined,
  }),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string) => key,
  }),
}));
vi.mock("react-device-detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-device-detect")>()),
  get isMobile() {
    return fixture.mobile;
  },
}));
vi.mock("@/hooks/resize-observer", () => ({
  useResizeObserver: () => [
    { width: fixture.containerWidth, height: 0, x: 0, y: 0 },
  ],
}));
vi.mock("react-konva", () => ({
  Stage: ({
    children,
    width,
    height,
  }: {
    children?: React.ReactNode;
    width: number;
    height: number;
  }) => (
    <div data-testid="stage" data-width={width} data-height={height}>
      {children}
    </div>
  ),
  Layer: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Rect: (props: RectProps) => {
    fixture.rectProps = props;
    assignRef(props.ref, fixture.rectNode);
    return (
      <div
        data-testid="rect"
        data-x={props.x}
        data-y={props.y}
        data-width={props.width}
        data-height={props.height}
      />
    );
  },
  Transformer: (props: TransformerProps) => {
    fixture.transformerProps = props;
    assignRef(props.ref, fixture.transformerNode);
    return null;
  },
}));

function camera(
  overrides: {
    friendly_name?: string;
    width?: number;
    height?: number;
    enabled?: boolean;
    enabled_in_config?: boolean;
    order?: number;
  } = {},
) {
  return {
    friendly_name: overrides.friendly_name,
    enabled: overrides.enabled ?? true,
    enabled_in_config: overrides.enabled_in_config ?? true,
    ui: { order: overrides.order ?? 0 },
    detect: { width: overrides.width ?? 1280, height: overrides.height ?? 720 },
  };
}

function baseConfig() {
  return {
    cameras: {
      front_door: camera({ friendly_name: "Front Door", order: 2 }),
      side_gate: camera({ width: 720, height: 1280, order: 1 }),
      garage: camera({ enabled: false }),
      attic: camera({ enabled_in_config: false }),
      _replay_front: camera(),
    },
  };
}

function renderStep(initialData?: Partial<Step2FormData>) {
  const onNext = vi.fn<(data: Step2FormData) => void>();
  const onBack = vi.fn<() => void>();
  render(
    <Step2StateArea
      {...(initialData ? { initialData } : {})}
      onNext={onNext}
      onBack={onBack}
    />,
  );
  return { onNext, onBack };
}

function continueButton() {
  return screen.getByRole("button", { name: "button.continue" });
}

function cameraRow(name: string) {
  const row = screen.getByText(name).closest<HTMLElement>("[role=button]");
  if (!row) {
    throw new Error(`no row for ${name}`);
  }
  return row;
}

function lastCrop(onNext: ReturnType<typeof renderStep>["onNext"]) {
  return onNext.mock.calls.at(-1)?.[0].cameraAreas ?? [];
}

beforeEach(() => {
  fixture.config = baseConfig();
  fixture.containerWidth = 1600;
  fixture.mobile = false;
  fixture.rectProps = undefined;
  fixture.transformerProps = undefined;
  fixture.transformerNodes.length = 0;
  fixture.batchDraws.length = 0;
  Object.assign(fixture.rectState, {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    scaleX: 1,
    scaleY: 1,
  });
});

describe("Step2StateArea", () => {
  it("starts empty with continue disabled and goes back", () => {
    const { onBack } = renderStep();

    expect(screen.getByText("wizard.step2.cameras")).toBeInTheDocument();
    expect(screen.getByText("wizard.step2.noCameras")).toBeInTheDocument();
    expect(
      screen.getByText("wizard.step2.selectCameraPrompt"),
    ).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "button.back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("lists only enabled live cameras in ui order", () => {
    renderStep();
    fireEvent.click(
      screen.getByRole("button", { name: "a11yLabels.addCamera" }),
    );

    expect(screen.getByText("wizard.step2.selectCamera")).toBeInTheDocument();
    const heading = screen.getByText("wizard.step2.selectCamera");
    const list = heading.parentElement?.querySelector(".max-h-\\[30vh\\]");
    const names = Array.from(list?.querySelectorAll("button") ?? []).map(
      (button) => button.textContent,
    );
    expect(names).toEqual(["side gate", "Front Door"]);
  });

  it("adds a centered square crop for a landscape camera", () => {
    const { onNext } = renderStep();
    fireEvent.click(
      screen.getByRole("button", { name: "a11yLabels.addCamera" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Front Door" }));

    expect(
      screen.queryByText("wizard.step2.selectCamera"),
    ).not.toBeInTheDocument();
    expect(cameraRow("Front Door")).toHaveAttribute("aria-pressed", "true");
    const image = screen.getByRole("img", { name: "Front Door" });
    expect(image).toHaveAttribute(
      "src",
      `${baseUrl}api/front_door/latest.jpg?h=500`,
    );
    expect(screen.getByTestId("stage")).toHaveAttribute("data-width", "1600");
    expect(screen.getByTestId("stage")).toHaveAttribute("data-height", "900");

    fireEvent.click(continueButton());
    const [area] = lastCrop(onNext);
    expect(area?.camera).toBe("front_door");
    const expected = [0.415625, 0.35, 0.584375, 0.65];
    area?.crop.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 6);
    });
  });

  it("adds a centered square crop for a portrait camera", () => {
    const { onNext } = renderStep();
    fireEvent.click(
      screen.getByRole("button", { name: "a11yLabels.addCamera" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "side gate" }));

    // a 9:16 camera fits the 16:9 box by height
    expect(screen.getByTestId("stage")).toHaveAttribute("data-height", "900");
    expect(screen.getByTestId("stage")).toHaveAttribute("data-width", "506.25");

    fireEvent.click(continueButton());
    const expected = [0.35, 0.415625, 0.65, 0.584375];
    lastCrop(onNext)[0]?.crop.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 6);
    });
  });

  it("fits an ultra wide camera by width", () => {
    fixture.config = {
      cameras: { pano: camera({ width: 3200, height: 900 }) },
    };
    renderStep({ cameraAreas: [{ camera: "pano", crop: [0, 0, 0.5, 0.5] }] });
    expect(screen.getByTestId("stage")).toHaveAttribute("data-width", "1600");
    expect(screen.getByTestId("stage")).toHaveAttribute("data-height", "450");
  });

  it("disables adding once every camera is used", () => {
    renderStep({
      cameraAreas: [
        { camera: "front_door", crop: [0, 0, 0.5, 0.5] },
        { camera: "side_gate", crop: [0, 0, 0.5, 0.5] },
      ],
    });

    expect(
      screen.queryByRole("button", { name: "a11yLabels.addCamera" }),
    ).not.toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    expect(buttons.some((button) => button.hasAttribute("disabled"))).toBe(
      true,
    );
  });

  it("disables adding before the config loads", () => {
    fixture.config = undefined;
    renderStep();
    expect(
      screen.queryByRole("button", { name: "a11yLabels.addCamera" }),
    ).not.toBeInTheDocument();
  });

  it("switches and removes cameras", () => {
    const { onNext } = renderStep({
      cameraAreas: [
        { camera: "front_door", crop: [0.1, 0.1, 0.4, 0.4] },
        { camera: "side_gate", crop: [0.2, 0.2, 0.5, 0.5] },
      ],
    });

    expect(cameraRow("Front Door")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(cameraRow("side gate"));
    expect(cameraRow("side gate")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("img", { name: "side gate" })).toBeInTheDocument();

    fireEvent.keyDown(cameraRow("Front Door"), { key: "Enter" });
    expect(cameraRow("Front Door")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(cameraRow("side gate"));
    fireEvent.click(within(cameraRow("side gate")).getByRole("button"));
    expect(screen.queryByText("side gate")).not.toBeInTheDocument();
    expect(cameraRow("Front Door")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(continueButton());
    expect(onNext).toHaveBeenLastCalledWith({
      cameraAreas: [{ camera: "front_door", crop: [0.1, 0.1, 0.4, 0.4] }],
    });

    fireEvent.click(within(cameraRow("Front Door")).getByRole("button"));
    expect(screen.getByText("wizard.step2.noCameras")).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
  });

  it("selects the next camera when the selected first one is removed", () => {
    renderStep({
      cameraAreas: [
        { camera: "front_door", crop: [0.1, 0.1, 0.4, 0.4] },
        { camera: "side_gate", crop: [0.2, 0.2, 0.5, 0.5] },
      ],
    });
    fireEvent.click(within(cameraRow("Front Door")).getByRole("button"));
    expect(screen.queryByText("Front Door")).not.toBeInTheDocument();
    expect(cameraRow("side gate")).toHaveAttribute("aria-pressed", "true");
  });

  it("places the crop rectangle and attaches the transformer on load", () => {
    renderStep({
      cameraAreas: [{ camera: "front_door", crop: [0.25, 0.5, 0.5, 0.75] }],
    });

    const rect = screen.getByTestId("rect");
    expect(rect).toHaveAttribute("data-x", "400");
    expect(rect).toHaveAttribute("data-y", "450");
    expect(rect).toHaveAttribute("data-width", "400");
    expect(rect).toHaveAttribute("data-height", "225");
    expect(fixture.transformerNodes).toHaveLength(0);

    fixture.rectState.scaleX = 2;
    fireEvent.load(screen.getByRole("img", { name: "Front Door" }));
    expect(fixture.transformerNodes).toEqual([[fixture.rectNode]]);
    expect(fixture.batchDraws.length).toBeGreaterThan(0);
    expect(fixture.rectState.scaleX).toBe(1);
  });

  it("squares and normalizes the rectangle after a drag or resize", () => {
    const { onNext } = renderStep({
      cameraAreas: [{ camera: "front_door", crop: [0.25, 0.25, 0.5, 0.5] }],
    });

    Object.assign(fixture.rectState, {
      x: 160,
      y: 90,
      width: 400,
      height: 400,
      scaleX: 1.5,
      scaleY: 1,
    });
    act(() => {
      fixture.rectProps?.onTransformEnd();
    });
    expect(fixture.rectState).toMatchObject({
      width: 500,
      height: 500,
      scaleX: 1,
      scaleY: 1,
    });

    fireEvent.click(continueButton());
    const crop = lastCrop(onNext)[0]?.crop ?? [];
    const expected = [0.1, 0.1, 660 / 1600, 590 / 900];
    crop.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 6);
    });

    Object.assign(fixture.rectState, { x: 0, y: 0, width: 160, height: 160 });
    act(() => {
      fixture.rectProps?.onDragEnd();
    });
    fireEvent.click(continueButton());
    const dragged = lastCrop(onNext)[0]?.crop ?? [];
    expect(dragged[0]).toBe(0);
    expect(dragged[2]).toBeCloseTo(0.1, 6);
  });

  it("keeps drags inside the image", () => {
    renderStep({
      cameraAreas: [{ camera: "front_door", crop: [0.25, 0.25, 0.5, 0.5] }],
    });
    fixture.rectState.width = 500;

    expect(fixture.rectProps?.dragBoundFunc({ x: -5, y: 2000 })).toEqual({
      x: 0,
      y: 400,
    });
    expect(fixture.rectProps?.dragBoundFunc({ x: 300, y: 100 })).toEqual({
      x: 300,
      y: 100,
    });
  });

  it("clamps resizes to a square within the image", () => {
    renderStep({
      cameraAreas: [{ camera: "front_door", crop: [0.25, 0.25, 0.5, 0.5] }],
    });
    const old: Box = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };

    expect(
      fixture.transformerProps?.boundBoxFunc(old, {
        x: -10,
        y: -10,
        width: 10,
        height: 2000,
        rotation: 0,
      }),
    ).toEqual({ x: 0, y: 0, width: 475, height: 475, rotation: 0 });

    expect(
      fixture.transformerProps?.boundBoxFunc(old, {
        x: 1500,
        y: 800,
        width: 200,
        height: 300,
        rotation: 0,
      }),
    ).toEqual({ x: 1350, y: 650, width: 250, height: 250, rotation: 0 });
  });

  it("waits for the container size before drawing", () => {
    fixture.containerWidth = 0;
    renderStep({
      cameraAreas: [{ camera: "front_door", crop: [0.25, 0.25, 0.5, 0.5] }],
    });
    expect(screen.queryByTestId("stage")).not.toBeInTheDocument();
    expect(
      screen.getByText("wizard.step2.selectCameraPrompt"),
    ).toBeInTheDocument();
    expect(continueButton()).toBeEnabled();
  });

  it("stacks the layout on mobile", () => {
    fixture.mobile = true;
    const { container } = render(
      <Step2StateArea onNext={vi.fn()} onBack={vi.fn()} />,
    );
    expect(container.querySelector(".flex-col.gap-4.overflow-hidden")).not.toBe(
      null,
    );
    expect(container.querySelector(".w-full.bg-secondary")).not.toBe(null);
  });
});
