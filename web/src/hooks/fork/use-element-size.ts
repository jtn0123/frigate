/**
 * Content-box size of an element, observed from the moment it mounts.
 *
 * Uses a callback ref, so the observer attaches on mount even when nothing
 * else re-renders the component (the shared `useResizeObserver` reads
 * `ref.current` during render and misses an element that mounts last).
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type ElementSize = { width: number; height: number };

export function useElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  ElementSize,
] {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    observer.current = new ResizeObserver((entries) => {
      const box = entries.at(0)?.contentRect;
      if (!box) return;
      setSize((previous) =>
        previous.width === box.width && previous.height === box.height
          ? previous
          : { width: box.width, height: box.height },
      );
    });
    observer.current.observe(node);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return [ref, size];
}
