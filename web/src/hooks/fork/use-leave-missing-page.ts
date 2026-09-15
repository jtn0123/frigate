import { useEffect, useRef } from "react";

/**
 * Fork (UI85): the face library and a classification model's training view
 * keep the open collection in state. The backend removes a face or category
 * folder once it is empty (a bulk delete, or its last image reclassified),
 * so when newly loaded data no longer has the open page, go back to `home`.
 *
 * Only a change in the data runs the check: a rename moves the page to the
 * new name before the data has it.
 */
export function useLeaveMissingPage(
  page: string | undefined,
  pages: Readonly<Record<string, unknown>> | undefined,
  setPage: (page: string) => void,
  home = "train",
) {
  const latest = useRef({ page, setPage });
  useEffect(() => {
    latest.current = { page, setPage };
  });

  useEffect(() => {
    const { page: open, setPage: leave } = latest.current;
    if (pages && open !== undefined && open !== home && !(open in pages)) {
      leave(home);
    }
  }, [pages, home]);
}
