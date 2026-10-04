/**
 * Slide cycling for the wall display (UI19, flag `kioskMode`).
 *
 * Advances one slide every `seconds` while it runs. A manual step, a resume
 * or the end of a hold (an alert takeover) starts a full interval again, so
 * a slide someone just stepped to is never swapped out a moment later.
 */

import { useCallback, useEffect, useState } from "react";
import { stepIndex } from "@/lib/fork/kiosk";

export type KioskCycle = {
  /** Current slide, always inside `0..count-1` (0 when empty). */
  index: number;
  paused: boolean;
  /** True while the timer is counting down to the next slide. */
  running: boolean;
  /** Changes whenever the countdown restarts; key progress bars on it. */
  epoch: number;
  step: (delta: number) => void;
  togglePaused: () => void;
};

export function useKioskCycle(
  count: number,
  seconds: number,
  hold: boolean,
): KioskCycle {
  const [rawIndex, setRawIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [epoch, setEpoch] = useState(0);

  const index = count > 0 ? rawIndex % count : 0;
  const running = seconds > 0 && count > 1 && !paused && !hold;

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => {
      setRawIndex((current) => stepIndex(current, count, 1));
      setEpoch((current) => current + 1);
    }, seconds * 1000);
    return () => clearTimeout(timer);
  }, [running, seconds, count, epoch]);

  const step = useCallback(
    (delta: number) => {
      setRawIndex((current) => stepIndex(current, count, delta));
      setEpoch((current) => current + 1);
    },
    [count],
  );

  const togglePaused = useCallback(() => {
    setPaused((current) => !current);
    setEpoch((current) => current + 1);
  }, []);

  return { index, paused, running, epoch, step, togglePaused };
}
