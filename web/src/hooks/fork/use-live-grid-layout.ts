/**
 * Live grid layout memory (fork, flag `liveLayoutMemory`).
 *
 * Upstream persists one `${group}-draggable-layout` arrangement per user, so
 * a phone rearranging the grid overwrites the desktop and vice versa. This
 * hook keeps that shared key as the seed for devices that have never saved
 * a layout, and stores each device's own arrangement under
 * `${group}-draggable-layout:${deviceProfile}` (see lib/fork/device-profile).
 *
 * Writes go to both keys: the device key wins on read, the shared key stays
 * fresh for the next new device and for the upstream code path when the
 * flag is off.
 */

import { useCallback } from "react";
import type { Layout } from "react-grid-layout";
import { useUserPersistence } from "@/hooks/use-user-persistence";
import { useViewport } from "@/hooks/fork/use-viewport";
import { getDeviceProfile } from "@/lib/fork/device-profile";
import { forkFlags } from "@/fork/flags";
import "@/components/fork/live-grid.css";

const enabled = forkFlags.liveLayoutMemory;

/** Class that enables the touch-friendly resize handles (see live-grid.css). */
export const liveGridClassName = enabled ? "fork-live-grid" : undefined;

export type LiveGridLayoutPersistence = [
  layout: Layout | undefined,
  setLayout: (layout: Layout | undefined) => void,
  loaded: boolean,
  deleteLayout: () => void,
];

export function useLiveGridLayout(
  cameraGroup: string,
): LiveGridLayoutPersistence {
  const { class: viewportClass } = useViewport();
  const sharedKey = `${cameraGroup}-draggable-layout`;
  const deviceKey = `${sharedKey}:${getDeviceProfile(viewportClass)}`;

  const [sharedLayout, setSharedLayout, sharedLoaded, deleteSharedLayout] =
    useUserPersistence<Layout>(sharedKey);
  const [deviceLayout, setDeviceLayout, deviceLoaded, deleteDeviceLayout] =
    useUserPersistence<Layout>(deviceKey);

  const setLayout = useCallback(
    (layout: Layout | undefined) => {
      setDeviceLayout(layout);
      setSharedLayout(layout);
    },
    [setDeviceLayout, setSharedLayout],
  );

  const deleteLayout = useCallback(() => {
    deleteDeviceLayout();
    deleteSharedLayout();
  }, [deleteDeviceLayout, deleteSharedLayout]);

  if (!enabled) {
    return [sharedLayout, setSharedLayout, sharedLoaded, deleteSharedLayout];
  }

  return [
    deviceLayout ?? sharedLayout,
    setLayout,
    sharedLoaded && deviceLoaded,
    deleteLayout,
  ];
}
