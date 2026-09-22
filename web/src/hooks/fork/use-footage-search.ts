import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import type { SearchResult } from "@/types/search";

/** Shortest query worth a round trip to the search endpoint. */
export const MIN_FOOTAGE_QUERY = 2;

/** How many clips the palette shows before the "see all" row. */
export const FOOTAGE_RESULT_LIMIT = 5;

/** Idle time before a keystroke turns into a request. */
export const FOOTAGE_DEBOUNCE_MS = 300;

/**
 * Debounce a value so a fast typist makes one request, not one per keystroke.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

type FootageSearch = {
  /** Results for the settled query, empty until one arrives. */
  results: SearchResult[];
  /** True while a query long enough to search has no answer yet. */
  isLoading: boolean;
  /** The query the results belong to, so callers can label a "see all" row. */
  query: string;
};

/**
 * Search recorded footage for the command palette.
 *
 * `/events/search` is the semantic endpoint and answers 400 when semantic
 * search is off, so `enabled` has to carry `semantic_search.enabled` from the
 * config rather than letting the request fail and raise a read error toast.
 */
export function useFootageSearch(
  rawQuery: string,
  enabled: boolean,
): FootageSearch {
  const query = useDebounced(rawQuery.trim(), FOOTAGE_DEBOUNCE_MS);
  const canSearch = enabled && query.length >= MIN_FOOTAGE_QUERY;

  const { data, isLoading } = useSWR<SearchResult[]>(
    canSearch
      ? [
          "events/search",
          {
            query,
            limit: FOOTAGE_RESULT_LIMIT,
            include_thumbnails: 0,
          },
        ]
      : null,
    {
      revalidateOnFocus: false,
      // the palette is transient: a result set is worth keeping for a moment
      // in case the same query is typed again, but not worth refetching
      revalidateIfStale: false,
      // a failed search should leave the palette usable, not retry in a loop
      shouldRetryOnError: false,
    },
  );

  const results = useMemo(() => data ?? [], [data]);

  return {
    results,
    isLoading: canSearch && isLoading,
    query: canSearch ? query : "",
  };
}
