import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrigateReview } from "@/types/ws";
import type { ReviewSegment } from "@/types/review";
import {
  INBOX_DISMISSED_KEY,
  INBOX_ITEMS_KEY,
  INBOX_MAX_ITEMS,
  INBOX_MAX_DISMISSED,
  INBOX_SETTINGS_KEY,
  clearInbox,
  getInboxState,
  ingestReview,
  isInQuietHours,
  markAllInboxRead,
  markInboxRead,
  reloadInboxFromStorage,
  removeInboxItem,
  setCameraMuted,
  setQuietHours,
  subscribeInbox,
} from "./inbox-store";

function message(id: string, type: FrigateReview["type"]): FrigateReview {
  const segment: ReviewSegment = {
    id,
    camera: "front_door",
    severity: "alert",
    start_time: 1_000,
    ...(type === "end" ? { end_time: 1_030 } : {}),
    thumb_path: `/media/frigate/clips/review/thumb-${id}.webp`,
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: [],
      objects: ["person"],
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
    },
  };
  return { type, before: segment, after: segment };
}

function ids() {
  return getInboxState().items.map((item) => item.id);
}

describe("inbox store", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadInboxFromStorage();
  });

  it("adds an item for a new review and updates it afterwards", () => {
    expect(ingestReview(message("r1", "new"))).toBe(true);
    expect(ingestReview(message("r1", "end"))).toBe(true);
    expect(ids()).toEqual(["r1"]);
    expect(getInboxState().items.at(0)?.endTime).toBe(1_030);
  });

  it("merges a storage update from another tab without losing a local read", () => {
    const unsubscribe = subscribeInbox(() => {});
    try {
      ingestReview(message("local", "new"));
      markInboxRead("local");
      const local = getInboxState().items[0];
      const external = { ...local, id: "external", read: false };
      localStorage.setItem(INBOX_ITEMS_KEY, JSON.stringify([external]));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: INBOX_ITEMS_KEY,
          newValue: JSON.stringify([external]),
        }),
      );
      expect(ids()).toEqual(["external", "local"]);
      expect(
        getInboxState().items.find((item) => item.id === "local")?.read,
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("shows a new alert when another tab escalates a read detection", () => {
    const unsubscribe = subscribeInbox(() => {});
    try {
      ingestReview(message("r1", "new"));
      const detection = {
        ...getInboxState().items[0],
        severity: "detection" as const,
      };
      localStorage.setItem(INBOX_ITEMS_KEY, JSON.stringify([detection]));
      reloadInboxFromStorage();
      markInboxRead("r1");

      const alert = { ...detection, severity: "alert" as const, read: false };
      localStorage.setItem(INBOX_ITEMS_KEY, JSON.stringify([alert]));
      window.dispatchEvent(
        new StorageEvent("storage", { key: INBOX_ITEMS_KEY }),
      );
      expect(getInboxState().items[0]).toMatchObject({
        severity: "alert",
        read: false,
      });
    } finally {
      unsubscribe();
    }
  });

  it("does not add an item from an update whose start it never saw", () => {
    expect(ingestReview(message("r1", "update"))).toBe(false);
    expect(ids()).toEqual([]);
  });

  it("keeps a dismissed review out while it is still active", () => {
    ingestReview(message("r1", "new"));
    removeInboxItem("r1");

    // the reviews topic keeps sending updates, and the collector re-ingests
    // the last message when it remounts
    expect(ingestReview(message("r1", "update"))).toBe(false);
    expect(ingestReview(message("r1", "new"))).toBe(false);
    expect(ingestReview(message("r1", "end"))).toBe(false);
    expect(ids()).toEqual([]);
  });

  it("keeps cleared reviews out", () => {
    ingestReview(message("r1", "new"));
    ingestReview(message("r2", "new"));
    clearInbox();

    ingestReview(message("r1", "update"));
    ingestReview(message("r2", "new"));
    expect(ids()).toEqual([]);

    ingestReview(message("r3", "new"));
    expect(ids()).toEqual(["r3"]);
  });

  it("remembers dismissed reviews across a reload, keeping the newest", () => {
    ingestReview(message("r1", "new"));
    removeInboxItem("r1");
    reloadInboxFromStorage();
    ingestReview(message("r1", "new"));
    expect(ids()).toEqual([]);

    for (let i = 0; i < INBOX_MAX_DISMISSED; i++) {
      ingestReview(message(`d${i}`, "new"));
      removeInboxItem(`d${i}`);
    }
    const stored: unknown = JSON.parse(
      localStorage.getItem(INBOX_DISMISSED_KEY) ?? "[]",
    );
    expect(stored).toHaveLength(INBOX_MAX_DISMISSED);

    // r1 was the oldest dismissal and has been dropped
    ingestReview(message("r1", "new"));
    expect(ids()).toEqual(["r1"]);
  });

  it("syncs camera mute and quiet hours from another tab", () => {
    const changes: string[] = [];
    const unsubscribe = subscribeInbox(() => changes.push("changed"));
    try {
      localStorage.setItem(
        INBOX_SETTINGS_KEY,
        JSON.stringify({
          mutedCameras: ["front_door", 5],
          quietHours: { enabled: true, start: "21:00", end: "06:00" },
        }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: INBOX_SETTINGS_KEY }),
      );
      expect(getInboxState().settings).toEqual({
        mutedCameras: ["front_door"],
        quietHours: { enabled: true, start: "21:00", end: "06:00" },
      });
      expect(ingestReview(message("muted", "new"))).toBe(false);
      expect(changes).toHaveLength(1);

      window.dispatchEvent(
        new StorageEvent("storage", { key: INBOX_SETTINGS_KEY }),
      );
      expect(changes).toHaveLength(1);
      setCameraMuted("front_door", false);
      expect(ingestReview(message("unmuted", "new"))).toBe(true);
      expect(ids()).toEqual(["unmuted"]);
    } finally {
      unsubscribe();
    }
  });

  it("removes an item dismissed in another tab and ignores later updates", () => {
    const unsubscribe = subscribeInbox(() => {});
    try {
      ingestReview(message("r1", "new"));
      localStorage.setItem(INBOX_DISMISSED_KEY, JSON.stringify(["r1", 42]));
      window.dispatchEvent(
        new StorageEvent("storage", { key: INBOX_DISMISSED_KEY }),
      );
      expect(ids()).toEqual([]);
      expect(ingestReview(message("r1", "new"))).toBe(false);
      expect(
        JSON.parse(localStorage.getItem(INBOX_DISMISSED_KEY) ?? "[]"),
      ).toEqual(["r1"]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps a local dismissal when an older tab writes its items", () => {
    const unsubscribe = subscribeInbox(() => {});
    try {
      ingestReview(message("r1", "new"));
      const staleItem = getInboxState().items[0];
      removeInboxItem("r1");
      localStorage.setItem(INBOX_ITEMS_KEY, JSON.stringify([staleItem]));
      window.dispatchEvent(
        new StorageEvent("storage", { key: INBOX_ITEMS_KEY }),
      );
      expect(ids()).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("marks all unread alerts read and persists the change", () => {
    ingestReview(message("r1", "new"));
    ingestReview(message("r2", "new"));
    markAllInboxRead();
    expect(getInboxState().items.every((item) => item.read)).toBe(true);
    reloadInboxFromStorage();
    expect(getInboxState().items.every((item) => item.read)).toBe(true);
    markAllInboxRead();
  });

  it("supports daytime and overnight quiet hours and rejects bad times", () => {
    const at = (hour: number) => new Date(2026, 0, 1, hour);
    expect(
      isInQuietHours({ enabled: true, start: "09:00", end: "17:00" }, at(10)),
    ).toBe(true);
    expect(
      isInQuietHours({ enabled: true, start: "09:00", end: "17:00" }, at(18)),
    ).toBe(false);
    expect(
      isInQuietHours({ enabled: true, start: "22:00", end: "07:00" }, at(23)),
    ).toBe(true);
    expect(
      isInQuietHours({ enabled: true, start: "22:00", end: "07:00" }, at(12)),
    ).toBe(false);
    expect(
      isInQuietHours({ enabled: true, start: "25:00", end: "07:00" }, at(23)),
    ).toBe(false);
    expect(
      isInQuietHours({ enabled: true, start: "22:00", end: "22:00" }, at(23)),
    ).toBe(false);
    setQuietHours({ enabled: false, start: "22:00", end: "07:00" });
    expect(getInboxState().settings.quietHours.enabled).toBe(false);
  });

  it("sanitizes stored items, settings and dismissals on reload", () => {
    const valid = {
      id: "valid",
      camera: "front_door",
      severity: "detection",
      labels: [],
      zones: [],
      startTime: 1,
      thumbPath: "thumb",
      read: false,
      receivedAt: 1,
    };
    localStorage.setItem(INBOX_ITEMS_KEY, JSON.stringify([null, {}, valid]));
    localStorage.setItem(
      INBOX_SETTINGS_KEY,
      JSON.stringify({
        mutedCameras: ["front_door", 2],
        quietHours: { enabled: true },
      }),
    );
    localStorage.setItem(INBOX_DISMISSED_KEY, JSON.stringify([1, "old"]));
    reloadInboxFromStorage();
    expect(ids()).toEqual(["valid"]);
    expect(getInboxState().settings).toEqual({
      mutedCameras: ["front_door"],
      quietHours: { enabled: true, start: "22:00", end: "07:00" },
    });
    expect(ingestReview(message("old", "new"))).toBe(false);
  });

  it("caps the inbox at the newest 200 items", () => {
    for (let i = 0; i <= INBOX_MAX_ITEMS; i++) {
      ingestReview(message(`review-${i}`, "new"));
    }
    expect(ids()).toHaveLength(INBOX_MAX_ITEMS);
    expect(ids()[0]).toBe(`review-${INBOX_MAX_ITEMS}`);
    expect(ids()).not.toContain("review-0");
  });

  it("deduplicates labels and reopens a read detection when it becomes an alert", () => {
    const detection = message("r1", "new");
    detection.after.severity = "detection";
    detection.after.data = {
      ...detection.after.data,
      objects: ["person"],
      audio: ["bark", "person"],
      sub_labels: ["bark"],
    };
    expect(ingestReview(detection)).toBe(true);
    expect(getInboxState().items[0]?.labels).toEqual(["person", "bark"]);
    markInboxRead("r1");
    const alert = message("r1", "update");
    alert.after.thumb_path = "";
    expect(ingestReview(alert)).toBe(true);
    expect(getInboxState().items[0]).toMatchObject({
      severity: "alert",
      read: false,
      thumbPath: detection.after.thumb_path,
    });
  });

  it("marks arrivals during quiet hours read and leaves an escalation read", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 1, 23));
      setQuietHours({ enabled: true, start: "22:00", end: "07:00" });
      const detection = message("r1", "new");
      detection.after.severity = "detection";
      expect(ingestReview(detection)).toBe(true);
      expect(getInboxState().items[0]?.read).toBe(true);
      expect(ingestReview(message("r1", "update"))).toBe(true);
      expect(getInboxState().items[0]).toMatchObject({
        severity: "alert",
        read: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats invalid and boundary quiet times as outside the window", () => {
    const at = (hour: number, minute = 0) => new Date(2026, 0, 1, hour, minute);
    const quiet = { enabled: true, start: "9:30", end: "17:00" };
    expect(isInQuietHours(quiet, at(9, 29))).toBe(false);
    expect(isInQuietHours(quiet, at(9, 30))).toBe(true);
    expect(isInQuietHours(quiet, at(17))).toBe(false);
    expect(isInQuietHours({ ...quiet, start: "bad" }, at(10))).toBe(false);
    expect(isInQuietHours({ ...quiet, end: "12:60" }, at(10))).toBe(false);
    expect(isInQuietHours({ ...quiet, enabled: false }, at(10))).toBe(false);
  });
});
