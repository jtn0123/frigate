import { type Dispatch, type SetStateAction, useEffect } from "react";
import type { FrigateConfig } from "@/types/frigateConfig";
import { parseProfileFromSectionPath } from "@/utils/configUtil";

/**
 * Fork (UI78): Settings keeps pending edits (`camera::section`,
 * `camera::profiles.<profile>.section`) and the profile being edited on each
 * camera across pages. Deleting a profile or a camera left both behind, so
 * Save wrote `cameras.<camera>.profiles.<deleted>.*`, which the backend
 * rejects, or re-created a deleted camera with no inputs, and the
 * unsaved-changes guard never cleared. Once the config no longer has the
 * profile or camera, the entries that name it are dropped.
 */

type ConfigNames = { cameras: Set<string>; profiles: Set<string> };

function keysOf(value: unknown): Set<string> {
  return new Set(
    typeof value === "object" && value !== null ? Object.keys(value) : [],
  );
}

/** Whether a pending key names a camera or profile the config no longer has. */
export function isStalePendingKey(key: string, names: ConfigNames): boolean {
  const separator = key.indexOf("::");
  if (separator === -1) return false;
  if (!names.cameras.has(key.slice(0, separator))) return true;
  const { isProfile, profileName } = parseProfileFromSectionPath(
    key.slice(separator + 2),
  );
  return (
    isProfile && profileName !== undefined && !names.profiles.has(profileName)
  );
}

/** `state` without the entries `stale` picks, or `state` itself if none. */
function withoutStale<T>(
  state: Record<string, T>,
  stale: (key: string, value: T) => boolean,
): Record<string, T> {
  const kept = Object.entries(state).filter(
    ([key, value]) => !stale(key, value),
  );
  return kept.length === Object.keys(state).length
    ? state
    : Object.fromEntries(kept);
}

export function usePruneSettingsState<T>(
  config: FrigateConfig | undefined,
  setEditingProfile: Dispatch<SetStateAction<Record<string, string | null>>>,
  setPendingDataBySection: Dispatch<SetStateAction<Record<string, T>>>,
) {
  useEffect(() => {
    if (!config) return;
    const names: ConfigNames = {
      cameras: keysOf(config.cameras),
      profiles: keysOf(config.profiles),
    };
    setEditingProfile((prev) =>
      withoutStale(
        prev,
        (camera, profile) =>
          !names.cameras.has(camera) ||
          (profile !== null && !names.profiles.has(profile)),
      ),
    );
    setPendingDataBySection((prev) =>
      withoutStale(prev, (key) => isStalePendingKey(key, names)),
    );
  }, [config, setEditingProfile, setPendingDataBySection]);
}
