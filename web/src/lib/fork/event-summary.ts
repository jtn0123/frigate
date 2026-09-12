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
  // Every builder below sets these; the source fields may be missing.
  subLabel: string | null | undefined;
  startTime: number;
  endTime: number | undefined;
  type: EventType | undefined;
  zones: string[] | undefined;
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
    type: search.data.type,
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
    type: event.data.type,
    zones: event.zones,
  };
}

export function summaryFromReview(review: ReviewSegment): EventSummaryData {
  const label = review.data.objects.at(0) ?? review.severity;
  return {
    camera: review.camera,
    label,
    subLabel: review.data.sub_labels?.at(0),
    startTime: toUnixTime(review.start_time) ?? 0,
    endTime: toUnixTime(review.end_time),
    type: "object",
    zones: review.data.zones,
  };
}
