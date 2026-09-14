import { useCallback, useRef, useState } from "react";

/** Serialize a user action and keep its failure available for an inline retry. */
export function usePendingAction() {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setFailed(false);
    try {
      await action();
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, []);
  return { pending, failed, run };
}
