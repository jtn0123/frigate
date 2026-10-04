/**
 * Idle tracking for the wall display (UI19, flag `kioskMode`).
 *
 * `active` is true from load and after any pointer, touch, wheel or key
 * activity, and turns false once nothing has happened for `timeoutMs`. The
 * display hides its controls and the cursor while idle.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const ACTIVITY_EVENTS = [
  "pointermove",
  "pointerdown",
  "wheel",
  "keydown",
  "touchstart",
] as const;

export function useKioskIdle(timeoutMs: number): {
  active: boolean;
  wake: () => void;
} {
  const [active, setActive] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const wake = useCallback(() => {
    setActive(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(false), timeoutMs);
  }, [timeoutMs]);

  useEffect(() => {
    wake();
    for (const name of ACTIVITY_EVENTS) {
      document.addEventListener(name, wake, { passive: true });
    }
    return () => {
      clearTimeout(timer.current);
      for (const name of ACTIVITY_EVENTS) {
        document.removeEventListener(name, wake);
      }
    };
  }, [wake]);

  return { active, wake };
}
