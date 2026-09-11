/**
 * Normalize Review and Explore event shapes for the shared summary header.
 */

import type { Event } from "@/types/event";
import type { ReviewSegment } from "@/types/review";
import type { EventType, SearchResult } from "@/types/search";
import { toUnixTime } from "./timeline-scrubber";

export type EventSummaryData = {
  camera: string;
  label: string;
  subLabel?: string | null;
  startTime: number;
  endTime?: number;
  type?: EventType;
  zones?: string[];
};

export function summaryFromSearchResult(
  search: SearchResult,
): EventSummaryData {
  return {
    camera: search.camera,
    label: search.label,
    subLabel: search.sub_label,
    startTime: toUnixTime(search.start_time) ?? 0,
    endTime: toUnixTime(search.end_time),
    type: search.data?.type,
    zones: search.zones,
  };
}

export function summaryFromEvent(event: Event): EventSummaryData {
  return {
    camera: event.camera,
    label: event.label,
    subLabel: event.sub_label,
    startTime: toUnixTime(event.start_time) ?? 0,
    endTime: toUnixTime(event.end_time),
    type: event.data?.type,
    zones: event.zones,
  };
}

export function summaryFromReview(review: ReviewSegment): EventSummaryData {
  const objects = review.data?.objects ?? [];
  return {
    camera: review.camera,
    label: objects[0] ?? review.severity,
    subLabel: review.data?.sub_labels?.[0],
    startTime: toUnixTime(review.start_time) ?? 0,
    endTime: toUnixTime(review.end_time),
    type: "object",
    zones: review.data?.zones,
  };
}
