import { RefObject, useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

const positions = new Map<string, number>();
function remember(key: string, top: number) {
  positions.delete(key);
  positions.set(key, top);
  if (positions.size > 60) {
    const oldest = positions.keys().next().value;
    if (oldest !== undefined) positions.delete(oldest);
  }
}

/** Restore a list's own scroll container for each browser-history entry. */
export function useRestoredScroll(
  ref: RefObject<HTMLDivElement | null>,
  scope: string,
  ready = true,
) {
  const location = useLocation();
  const key = `${location.key}:${location.pathname}:${location.search}:${scope}`;
  useLayoutEffect(() => {
    let candidate = ref.current;
    if (!candidate || !ready) return;
    // Review also points this ref at its inner grid. Find the actual scroller.
    while (
      candidate.parentElement &&
      !/(auto|scroll)/.test(getComputedStyle(candidate).overflowY)
    ) {
      candidate = candidate.parentElement as HTMLDivElement;
      if (candidate.id === "pageRoot") return;
    }
    const element = candidate;
    const top = positions.get(key);
    let restoring = top !== undefined;
    const restore = () => {
      if (!restoring || top === undefined) return;
      element.scrollTop = top;
      if (Math.abs(element.scrollTop - top) < 1) restoring = false;
    };
    const cancelRestore = () => {
      restoring = false;
    };
    const onScroll = () => {
      if (!restoring) remember(key, element.scrollTop);
    };
    const observer = new ResizeObserver(restore);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    const mutations = new MutationObserver(restore);
    mutations.observe(element, { childList: true, subtree: true });
    restore();
    const timeout = window.setTimeout(cancelRestore, 10000);
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", cancelRestore, { passive: true });
    element.addEventListener("touchstart", cancelRestore, { passive: true });
    element.addEventListener("keydown", cancelRestore);
    return () => {
      if (!restoring) remember(key, element.scrollTop);
      clearTimeout(timeout);
      observer.disconnect();
      mutations.disconnect();
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", cancelRestore);
      element.removeEventListener("touchstart", cancelRestore);
      element.removeEventListener("keydown", cancelRestore);
    };
  }, [key, ready, ref]);
}
