import type Konva from "konva";
import { afterEach, describe, expect, it, vi } from "vitest";

const asContext = (value: unknown) => value as CanvasRenderingContext2D;
const asShape = (value: unknown) => value as Konva.Shape;

async function load() {
  vi.resetModules();
  return import("./exclusion-fill");
}

function fakeContext() {
  return {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exclusionShapeProps", () => {
  it("hatches the zone's own fill and dashes a red outline", async () => {
    const ctx = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      asContext(ctx),
    );
    const { exclusionShapeProps, EXCLUSION_STROKE } = await load();

    const props = exclusionShapeProps("rgba(1,2,3,0.3)");

    expect(props.stroke).toBe(EXCLUSION_STROKE);
    expect(props.dash).toEqual([8, 5]);
    expect(props.fillPriority).toBe("pattern");
    expect(props.fillPatternRepeat).toBe("repeat");
    // the tile is set through the shape's own setter
    const fillPatternImage = vi.fn();
    props.ref?.(asShape({ fillPatternImage }));
    expect(fillPatternImage).toHaveBeenCalledTimes(1);
    expect(fillPatternImage.mock.calls[0]?.[0]).toBeInstanceOf(
      HTMLCanvasElement,
    );
    // React clears the ref with null when the shape goes away
    props.ref?.(null);
    expect(fillPatternImage).toHaveBeenCalledTimes(1);
    expect(ctx.fillStyle).toBe("rgba(1,2,3,0.3)");
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 12, 12);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
  });

  it("draws each fill's tile once", async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(asContext(fakeContext()));
    const { exclusionPattern } = await load();

    const first = exclusionPattern("red");
    expect(exclusionPattern("red")).toBe(first);
    exclusionPattern("blue");
    expect(getContext).toHaveBeenCalledTimes(2);
  });

  it("keeps the outline without canvas support", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { exclusionShapeProps, exclusionPattern } = await load();

    const props = exclusionShapeProps("green");

    expect(props.ref).toBeUndefined();
    expect(props.fillPriority).toBeUndefined();
    expect(props.dash).toEqual([8, 5]);
    // the missing canvas is remembered too
    expect(exclusionPattern("green")).toBeNull();
  });
});
