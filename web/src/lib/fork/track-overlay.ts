/**
 * Tracked-object overlay fixes (fork, flag `trackOverlay`).
 *
 * Upstream draws an object's box only within 10 ms of a recorded lifecycle
 * moment, so a paused frame between moments shows no box. It also plots the
 * path at the bottom-center of each box (the ground point zones use), which
 * on a close-up camera sits on the frame's bottom edge.
 */

import { forkFlags } from "@/fork/flags";

export const trackOverlayFixes: boolean = forkFlags.trackOverlay;

/** Box is [left, top, width, height], normalized 0-1. */
export type TimedBox = {
  timestamp: number;
  box: [number, number, number, number];
};
export type TimedPoint = { timestamp: number; x: number; y: number };

/** Same tolerance upstream uses for a recorded box (seconds). */
const EXACT = 0.01;
/** Widest gap between two path points the box is interpolated across (seconds). */
export const MAX_PATH_GAP = 2;
/** How far from a lone path point the box is still placed on it (seconds). */
export const NEAR_POINT = 0.25;
/** Ground points this low mean the object's feet are below the frame. */
export const EDGE_Y = 0.98;

function nearest<T extends { timestamp: number }>(
  items: T[],
  time: number,
): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (
      !best ||
      Math.abs(item.timestamp - time) < Math.abs(best.timestamp - time)
    ) {
      best = item;
    }
  }
  return best;
}

/**
 * The object's box at `time` (detect-stream seconds).
 *
 * A recorded box within 10 ms wins, as upstream. Otherwise the ground point
 * comes from the path, interpolated between the points on either side when
 * they are at most MAX_PATH_GAP apart, and the size from the nearest
 * recorded box. Returns undefined when the path is too sparse to place the
 * object honestly, so no box is better than a box in the wrong place.
 */
export function boxAtTime(
  boxes: TimedBox[],
  path: TimedPoint[],
  time: number,
): number[] | undefined {
  const closest = nearest(boxes, time);
  if (!closest) {
    return undefined;
  }
  if (Math.abs(closest.timestamp - time) <= EXACT) {
    return closest.box;
  }

  let before: TimedPoint | undefined;
  let after: TimedPoint | undefined;
  for (const point of path) {
    if (point.timestamp <= time) {
      if (!before || point.timestamp > before.timestamp) {
        before = point;
      }
    } else if (!after || point.timestamp < after.timestamp) {
      after = point;
    }
  }

  let ground: { x: number; y: number } | undefined;
  if (before && after && after.timestamp - before.timestamp <= MAX_PATH_GAP) {
    const t = (time - before.timestamp) / (after.timestamp - before.timestamp);
    ground = {
      x: before.x + (after.x - before.x) * t,
      y: before.y + (after.y - before.y) * t,
    };
  } else {
    const lone = nearest(
      [before, after].filter((point): point is TimedPoint => !!point),
      time,
    );
    if (lone && Math.abs(lone.timestamp - time) <= NEAR_POINT) {
      ground = lone;
    }
  }
  if (!ground) {
    return undefined;
  }

  const [, , width, height] = closest.box;
  return [ground.x - width / 2, ground.y - height, width, height];
}

/** A path point whose ground point is out of frame (feet below the edge). */
export function isEdgePoint(y: number): boolean {
  return y >= EDGE_Y;
}

/** Every point is pinned to the edge, so the path says nothing useful. */
export function allOnEdge(points: { y: number }[]): boolean {
  return points.length > 0 && points.every((point) => isEdgePoint(point.y));
}
