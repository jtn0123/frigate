import useSWR from "swr";
import { isForkEnabled } from "@/fork/flags";
import {
  suggestionsKey,
  type ClassificationSuggestionsResponse,
} from "@/lib/fork/classification-suggestions";

/**
 * Suggested classes for the events on the train grid (fork I41).
 *
 * One request per page of events. Jev answers are cached server side, so
 * revalidating on focus would only repeat local work; it is left off.
 */
export function useClassificationSuggestions(
  modelName: string,
  eventIds: string,
) {
  const key = isForkEnabled("classificationSuggestions")
    ? suggestionsKey(modelName, eventIds)
    : null;
  return useSWR<ClassificationSuggestionsResponse>(key, {
    revalidateOnFocus: false,
  });
}
