import { useCallback } from "react";
import { usePersistence } from "@/hooks/use-persistence";

/**
 * Whether the train grid lists the events the model was least sure about
 * first (fork I49). Remembered per browser.
 */
export function useUnsureFirst(): [boolean, (value: boolean) => void] {
  const [value, setValue] = usePersistence<boolean>(
    "fork.trainUnsureFirst",
    false,
  );
  const set = useCallback((next: boolean) => setValue(next), [setValue]);
  return [value ?? false, set];
}
