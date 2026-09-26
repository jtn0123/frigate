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
