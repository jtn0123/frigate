/**
 * Fork (D20): the e2e mock data must look like what the real API returns.
 *
 * reviews.json once carried ISO-string times and "/clips/..." thumb paths,
 * review-summary.json had no last24Hours, and events.json had no
 * event_count. Every e2e run then rendered "Invalid Time", broken
 * thumbnails, zero badge counts and a bare i18n key, and still passed.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MOCK_DATA_DIR = resolve(__dirname, "../e2e/fixtures/mock-data");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(MOCK_DATA_DIR, name), "utf-8")) as T;
}

type Review = { start_time: unknown; end_time: unknown; thumb_path: string };
type Event = { label: string; start_time: unknown; event_count?: unknown };
type Export = { date: unknown; thumb_path: string; video_path: string };
type SummaryDay = Record<string, unknown>;

describe("e2e mock data matches the API contract", () => {
  it("reviews use epoch-second times and media-relative thumbnails", () => {
    const reviews = load<Review[]>("reviews.json");
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) {
      expect(typeof review.start_time).toBe("number");
      expect(typeof review.end_time).toBe("number");
      expect(review.end_time as number).toBeGreaterThanOrEqual(
        review.start_time as number,
      );
      // The UI strips this prefix; anything else becomes a "//clips" URL
      expect(review.thumb_path.startsWith("/media/frigate/clips/")).toBe(true);
    }
  });

  it("review summary includes the last24Hours bucket the badges read", () => {
    const summary = load<Record<string, SummaryDay>>("review-summary.json");
    const last24 = summary.last24Hours;
    expect(last24).toBeDefined();
    for (const key of [
      "reviewed_alert",
      "reviewed_detection",
      "total_alert",
      "total_detection",
    ]) {
      expect(typeof last24[key]).toBe("number");
    }
  });

  it("events carry the per-label event_count that /events/explore adds", () => {
    const events = load<Event[]>("events.json");
    const counts = new Map<string, number>();
    for (const event of events) {
      counts.set(event.label, (counts.get(event.label) ?? 0) + 1);
    }
    for (const event of events) {
      expect(typeof event.start_time).toBe("number");
      expect(event.event_count).toBe(counts.get(event.label));
    }
  });

  it("exports point at the backend's media paths", () => {
    const exports = load<Export[]>("exports.json");
    for (const exp of exports) {
      expect(typeof exp.date).toBe("number");
      expect(exp.thumb_path.startsWith("/media/frigate/clips/export/")).toBe(
        true,
      );
      expect(exp.video_path.startsWith("/media/frigate/exports/")).toBe(true);
    }
  });
});
