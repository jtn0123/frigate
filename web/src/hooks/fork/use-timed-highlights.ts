/**
 * Fork: names that stay highlighted for a while after an event (UI155).
 *
 * The Triggers settings page kept one timeout in an effect cleanup, so a
 * second trigger firing cleared the first one's timeout and the first row
 * stayed highlighted. Here every name has its own timeout: a name that fires
 * again restarts only its own, and `clear` (or unmounting) stops them all.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export function useTimedHighlights(durationMs: number) {
  const [highlighted, setHighlighted] = useState<string[]>([]);
  const timeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const highlight = useCallback(
    (name: string) => {
      setHighlighted((prev) => (prev.includes(name) ? prev : [...prev, name]));

      const pending = timeouts.current;
      clearTimeout(pending.get(name));
      pending.set(
        name,
        setTimeout(() => {
          pending.delete(name);
          setHighlighted((prev) => prev.filter((other) => other !== name));
        }, durationMs),
      );
    },
    [durationMs],
  );

  const clear = useCallback(() => {
    timeouts.current.forEach((timeout) => clearTimeout(timeout));
    timeouts.current.clear();
    setHighlighted([]);
  }, []);

  useEffect(() => {
    const pending = timeouts.current;
    return () => {
      pending.forEach((timeout) => clearTimeout(timeout));
      pending.clear();
    };
  }, []);

  return { highlighted, highlight, clear };
}
