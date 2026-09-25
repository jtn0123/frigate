import { useCallback } from "react";
import { isForkEnabled } from "@/fork/flags";
import { usePersistence } from "@/hooks/use-persistence";

/**
 * Whether the train grid lists the events the model was least sure about
 * first (fork I49). Remembered per browser. The third value is whether the
 * stored choice has been read; the grid holds its order until then so it
 * does not draw newest first and then jump. With the suggestions flag off
 * the order is upstream's and there is nothing to wait for.
 */
export function useUnsureFirst(): [boolean, (value: boolean) => void, boolean] {
  const [value, setValue, loaded] = usePersistence<boolean>(
    "fork.trainUnsureFirst",
    false,
  );
  const set = useCallback((next: boolean) => setValue(next), [setValue]);
  if (!isForkEnabled("classificationSuggestions")) {
    return [false, set, true];
  }
  return [value ?? false, set, loaded];
}
