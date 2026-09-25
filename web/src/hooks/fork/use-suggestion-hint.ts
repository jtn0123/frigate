import { useCallback } from "react";
import { usePersistence } from "@/hooks/use-persistence";

/**
 * Whether the one-line "how this works" hint above the train grid has been
 * dismissed (fork I41). Remembered per browser.
 */
export function useSuggestionHint(): [boolean, () => void] {
  const [seen, setSeen] = usePersistence<boolean>(
    "fork.suggestionHintSeen",
    false,
  );
  const dismiss = useCallback(() => setSeen(true), [setSeen]);
  return [seen ?? false, dismiss];
}
