import { useEffect, useRef } from "react";
import { recordNavigationSample } from "@/lib/fork/navigation-metrics";

/** Measure mounted-page metadata readiness, not video readiness or server CPU. */
export function usePageReady(target: string, ready: boolean) {
  const started = useRef(performance.now());
  const recorded = useRef(false);
  useEffect(() => {
    if (!ready || recorded.current) return;
    const frame = requestAnimationFrame(() => {
      recorded.current = true;
      recordNavigationSample({
        kind: "page",
        target,
        duration: performance.now() - started.current,
        outcome: "success",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, target]);
}
