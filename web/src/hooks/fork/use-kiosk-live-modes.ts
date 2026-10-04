/**
 * Live mode fallbacks for the wall display (UI19, flag `kioskMode`).
 *
 * A slide is remounted on every visit, so the MSE to WebRTC (or jsmpeg)
 * fallback a camera needed would otherwise be found again, with a failed
 * attempt and a slower start, every time the cycle comes back to it. This
 * keeps each camera's fallback in memory for as long as the display runs.
 * Like Live, a page that comes back into view tries each camera's own mode
 * again, so a passing failure does not pin a camera to a fallback for days.
 */

import { useCallback, useEffect, useState } from "react";
import type { LivePlayerMode } from "@/types/live";

export type KioskLiveModes = {
  /** The mode each camera fell back to; absent until one fails. */
  learnedModes: Partial<Record<string, LivePlayerMode>>;
  learnMode: (camera: string, mode: LivePlayerMode) => void;
};

export function useKioskLiveModes(): KioskLiveModes {
  const [learnedModes, setLearnedModes] = useState<
    Partial<Record<string, LivePlayerMode>>
  >({});

  const learnMode = useCallback((camera: string, mode: LivePlayerMode) => {
    setLearnedModes((current) =>
      current[camera] === mode ? current : { ...current, [camera]: mode },
    );
  }, []);

  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === "visible") setLearnedModes({});
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return { learnedModes, learnMode };
}
