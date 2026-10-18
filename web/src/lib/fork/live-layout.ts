/** Storage keys shared by live layouts, backup and reset controls. */
import { getDeviceProfile } from "./device-profile";
import type { ViewportClass } from "@/hooks/fork/use-viewport";

export const LAYOUT_VIEWPORTS = ["mobile", "tablet", "desktop"] as const;

export function layoutKeyForGroup(group: string): string {
  return `${group}-draggable-layout`;
}

export function deviceLayoutKeyForGroup(
  group: string,
  viewport: ViewportClass,
): string {
  return `${layoutKeyForGroup(group)}:${getDeviceProfile(viewport)}`;
}

export function allLayoutKeysForGroup(group: string): string[] {
  return [
    layoutKeyForGroup(group),
    ...LAYOUT_VIEWPORTS.map((viewport) =>
      deviceLayoutKeyForGroup(group, viewport),
    ),
  ];
}

/** One tile of a saved Live grid layout, in grid units. */
export type SavedGridItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * A saved Live grid layout read back for another view (the kiosk, UI19).
 * `rowUnit` is one grid row's height in column widths.
 */
export type SavedGrid = { items: SavedGridItem[]; rowUnit: number };

// Upstream #24461 (UI151) moved the grid to 96 columns with a row a quarter
// of a column tall, stored as `{ version: 2, naturalAspect, layout }`. Before
// it, a bare array on 12 columns of 16:9 cells.
const VERSIONED_ROW_UNIT = 1 / 4;
const LEGACY_ROW_UNIT = 9 / 16;
const LAYOUT_VERSION = 2;

function isGridItem(value: unknown): value is SavedGridItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item["i"] === "string" &&
    ["x", "y", "w", "h"].every((key) => typeof item[key] === "number")
  );
}

function gridItems(value: unknown): SavedGridItem[] | undefined {
  if (!Array.isArray(value) || !value.every(isGridItem)) return undefined;
  return value.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
}

/** Reads either stored shape; undefined for anything else. */
export function readSavedGrid(stored: unknown): SavedGrid | undefined {
  if (Array.isArray(stored)) {
    const items = gridItems(stored);
    return items ? { items, rowUnit: LEGACY_ROW_UNIT } : undefined;
  }
  if (typeof stored !== "object" || stored === null) return undefined;
  const versioned = stored as { version?: unknown; layout?: unknown };
  if (versioned.version !== LAYOUT_VERSION) return undefined;
  const items = gridItems(versioned.layout);
  return items ? { items, rowUnit: VERSIONED_ROW_UNIT } : undefined;
}
