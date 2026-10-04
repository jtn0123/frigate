/**
 * Fork (UI143): whether the recording view shows the synced multi-camera
 * grid. The choice is kept per browser so the grid stays on between visits.
 * With the `syncedPlayback` flag off the grid is never shown.
 */

import { useCallback, useState } from "react";
import { forkFlags } from "@/fork/flags";
import { readJson, writeJson } from "@/lib/fork/local-storage";

export const SYNCED_PLAYBACK_MODE_KEY = "frigateFork.syncedPlayback.grid";

export function useSyncedPlaybackMode(): [boolean, (on: boolean) => void] {
  const [grid, setGrid] = useState(() =>
    readJson<boolean>(SYNCED_PLAYBACK_MODE_KEY, false),
  );

  const update = useCallback((on: boolean) => {
    setGrid(on);
    writeJson(SYNCED_PLAYBACK_MODE_KEY, on);
  }, []);

  return [forkFlags.syncedPlayback && grid === true, update];
}
