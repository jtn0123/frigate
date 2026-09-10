import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useFrigateReviews } from "@/api/ws";
import {
  getInboxState,
  ingestReview,
  subscribeInbox,
  type InboxState,
} from "@/lib/fork/inbox-store";

export function useInbox(): InboxState {
  return useSyncExternalStore(subscribeInbox, getInboxState);
}

export function useInboxUnreadCount(): number {
  const { items } = useInbox();
  return useMemo(() => items.filter((item) => !item.read).length, [items]);
}

/**
 * Feeds the `reviews` WebSocket topic into the inbox store. Mount once from
 * a component that is always rendered (the bell in the sidebar/bottombar).
 */
export function useInboxCollector() {
  const review = useFrigateReviews();

  useEffect(() => {
    ingestReview(review);
  }, [review]);
}
