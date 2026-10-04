/**
 * Fork (D77): how the zone editor draws an exclusion zone, so it reads apart
 * from a normal zone: red diagonal hatching over the zone's own fill and a
 * dashed red outline.
 *
 * The hatch is a pattern on the zone's own shape rather than a shape of its
 * own, so the editor's point indexes (the drawer finds a dragged point by its
 * position among the group's children) stay as they are, and the hatch moves
 * with the zone while it is dragged.
 */

import type Konva from "konva";

export const EXCLUSION_STROKE = "rgb(220, 38, 38)";
const HATCH = "rgba(220, 38, 38, 0.9)";
const TILE = 12;

const patterns = new Map<string, HTMLCanvasElement | null>();

/** A repeating tile of the zone's fill with a red stripe, or null without canvas. */
export function exclusionPattern(fill: string): HTMLCanvasElement | null {
  const cached = patterns.get(fill);
  if (cached !== undefined) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d");
  let pattern: HTMLCanvasElement | null = null;

  if (ctx) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, TILE, TILE);
    ctx.strokeStyle = HATCH;
    ctx.lineWidth = 2;
    ctx.beginPath();
    // one stripe across the tile plus its two corner pieces, so the stripes
    // run on without a seam where tiles meet
    ctx.moveTo(0, TILE);
    ctx.lineTo(TILE, 0);
    ctx.moveTo(-1, 1);
    ctx.lineTo(1, -1);
    ctx.moveTo(TILE - 1, TILE + 1);
    ctx.lineTo(TILE + 1, TILE - 1);
    ctx.stroke();
    pattern = canvas;
  }

  patterns.set(fill, pattern);
  return pattern;
}

/**
 * Konva shape props that turn a zone's filled outline into an exclusion zone.
 * Spread after the zone's own props, which these replace; they are typed as
 * optional so that spread type checks.
 */
export type ExclusionShapeProps = Partial<
  Pick<
    Konva.ShapeConfig,
    "stroke" | "dash" | "fillPatternRepeat" | "fillPriority"
  >
> & {
  /**
   * Sets the hatch tile. Konva draws a canvas as a pattern, but its config
   * type names only images, so the tile goes through the shape's own setter,
   * which takes either.
   */
  ref?: (shape: Konva.Shape | null) => void;
};

export function exclusionShapeProps(fill: string): ExclusionShapeProps {
  const pattern = exclusionPattern(fill);
  return {
    stroke: EXCLUSION_STROKE,
    dash: [8, 5],
    ...(pattern && {
      ref: (shape: Konva.Shape | null) => {
        shape?.fillPatternImage(pattern);
      },
      fillPatternRepeat: "repeat",
      fillPriority: "pattern",
    }),
  };
}
