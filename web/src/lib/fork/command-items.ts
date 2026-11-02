/**
 * Static command palette data derived from upstream navigation structures.
 *
 * Settings sections come from `settingsViewGroups` in `types/settings.ts`,
 * the index upstream moved out of `pages/Settings.tsx` with its command menu
 * (#24256), so the palette deep links with `?page=<key>` without a copy of
 * the list to keep in sync (UI156).
 */

import {
  ALLOWED_VIEWS_FOR_VIEWER,
  settingsViewGroups,
  type SettingsType,
} from "@/types/settings";

export type SettingsSection = {
  /** `settingsViewGroups[].label`, translated via `views/settings:menu.<label>` */
  group: string;
  /** `SettingsType` key, translated via `views/settings:menu.<key>` */
  key: SettingsType;
};

export const SETTINGS_SECTIONS: SettingsSection[] = settingsViewGroups.flatMap(
  (group) => group.views.map((key) => ({ group: group.label, key })),
);

/** The sections a viewer may open; everything else is admin only. */
export const VIEWER_SETTINGS_SECTIONS: readonly SettingsType[] =
  ALLOWED_VIEWS_FOR_VIEWER;

export type VisibleCameraGroup = {
  name: string;
  /** The group's cameras this user may see, used as search terms. */
  cameras: string[];
};

/**
 * Camera groups the palette lists (from upstream #24256). A role limited to
 * some cameras only gets the groups holding one of them, and only those
 * cameras become search terms, so a hidden camera's name never surfaces a
 * group.
 */
export function visibleCameraGroups(
  groups: Record<string, { cameras: string[] }> | undefined,
  allowedCameras: readonly string[],
  fullAccess: boolean,
): VisibleCameraGroup[] {
  const visible: VisibleCameraGroup[] = [];
  for (const [name, group] of Object.entries(groups ?? {})) {
    const cameras = fullAccess
      ? group.cameras
      : group.cameras.filter((camera) => allowedCameras.includes(camera));
    if (cameras.length > 0) {
      visible.push({ name, cameras });
    }
  }
  return visible;
}
