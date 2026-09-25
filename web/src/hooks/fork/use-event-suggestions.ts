/**
 * Drafts for one event under every custom model that applies (fork I46).
 */

import useSWR from "swr";
import { isForkEnabled } from "@/fork/flags";
import {
  eventSuggestionsKey,
  type EventSuggestionsResponse,
} from "@/lib/fork/classification-suggestions";

export function useEventSuggestions(eventId: string | null) {
  const key =
    isForkEnabled("classificationSuggestions") && eventId
      ? eventSuggestionsKey(eventId)
      : null;
  return useSWR<EventSuggestionsResponse>(key, { revalidateOnFocus: false });
}
