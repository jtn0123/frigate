import { useCallback } from "react";
import { usePersistence } from "@/hooks/use-persistence";

/**
 * Whether the "how this works" hint above the train grid has been
 * dismissed (fork I41). Remembered per browser. The third value is whether
 * the stored answer has been read; render the hint only once it has, or it
 * flashes for people who dismissed it long ago.
 */
export function useSuggestionHint(): [boolean, () => void, boolean] {
  const [seen, setSeen, loaded] = usePersistence<boolean>(
    "fork.suggestionHintSeen",
    false,
  );
  const dismiss = useCallback(() => setSeen(true), [setSeen]);
  return [seen ?? false, dismiss, loaded];
}
