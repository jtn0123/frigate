/**
 * In-app notification inbox store.
 *
 * Collects review alerts and detections from the `reviews` WebSocket topic
 * into a capped, localStorage-persisted list. Module level so the badge in
 * the sidebar and the panel share one source of truth without a provider.
 */

import { readJson, writeJson } from "@/lib/fork/local-storage";
import type { FrigateReview } from "@/types/ws";
import type { ReviewSegment } from "@/types/review";

export type InboxItem = {
  /** Review segment id, also the dedupe key. */
  id: string;
  camera: string;
  severity: "alert" | "detection";
  labels: string[];
  zones: string[];
  startTime: number;
  /** Unset until the review segment ends. */
  endTime: number | undefined;
  thumbPath: string;
  read: boolean;
  /** Epoch ms when the item first arrived in this browser. */
  receivedAt: number;
};

export type QuietHours = {
  enabled: boolean;
  /** "HH:mm" local time */
  start: string;
  /** "HH:mm" local time */
  end: string;
};

export type InboxSettings = {
  mutedCameras: string[];
  quietHours: QuietHours;
};

export type InboxState = {
  items: InboxItem[];
  settings: InboxSettings;
};

export const INBOX_ITEMS_KEY = "frigateFork.inbox.items";
export const INBOX_SETTINGS_KEY = "frigateFork.inbox.settings";
export const INBOX_MAX_ITEMS = 200;
export const INBOX_DISMISSED_KEY = "frigateFork.inbox.dismissed";
/** Dismissed or cleared review ids remembered, newest last. */
export const INBOX_MAX_DISMISSED = 500;

const DEFAULT_SETTINGS: InboxSettings = {
  mutedCameras: [],
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
};

function sanitizeItems(value: unknown): InboxItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is InboxItem =>
        !!item &&
        typeof item === "object" &&
        typeof (item as InboxItem).id === "string" &&
        typeof (item as InboxItem).camera === "string",
    )
    .slice(0, INBOX_MAX_ITEMS);
}

function sanitizeSettings(value: unknown): InboxSettings {
  const raw = (value ?? {}) as Partial<InboxSettings>;
  return {
    mutedCameras: Array.isArray(raw.mutedCameras)
      ? raw.mutedCameras.filter((c) => typeof c === "string")
      : [],
    quietHours: {
      ...DEFAULT_SETTINGS.quietHours,
      ...raw.quietHours,
    },
  };
}

function sanitizeDismissed(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((id): id is string => typeof id === "string")
    .slice(-INBOX_MAX_DISMISSED);
}

let state: InboxState = {
  items: sanitizeItems(readJson(INBOX_ITEMS_KEY, [])),
  settings: sanitizeSettings(readJson(INBOX_SETTINGS_KEY, DEFAULT_SETTINGS)),
};

// A review keeps sending updates while it is active, so dismissed and
// cleared ids are remembered to keep them from coming back as unread.
let dismissed: string[] = sanitizeDismissed(readJson(INBOX_DISMISSED_KEY, []));

function dismiss(ids: string[]) {
  if (ids.length === 0) return;
  const incoming = new Set(ids);
  dismissed = [...dismissed.filter((id) => !incoming.has(id)), ...ids].slice(
    -INBOX_MAX_DISMISSED,
  );
  writeJson(INBOX_DISMISSED_KEY, dismissed);
}

const listeners = new Set<() => void>();

function emit() {
  for (const listener of Array.from(listeners)) listener();
}

function setItems(items: InboxItem[]) {
  state = { ...state, items: items.slice(0, INBOX_MAX_ITEMS) };
  writeJson(INBOX_ITEMS_KEY, state.items);
  emit();
}

function setSettings(settings: InboxSettings) {
  state = { ...state, settings };
  writeJson(INBOX_SETTINGS_KEY, settings);
  emit();
}

export function subscribeInbox(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getInboxState(): InboxState {
  return state;
}

/** Test and reload helper: re-read persisted state. */
export function reloadInboxFromStorage() {
  state = {
    items: sanitizeItems(readJson(INBOX_ITEMS_KEY, [])),
    settings: sanitizeSettings(readJson(INBOX_SETTINGS_KEY, DEFAULT_SETTINGS)),
  };
  dismissed = sanitizeDismissed(readJson(INBOX_DISMISSED_KEY, []));
  emit();
}

function minutesOf(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * True when `now` falls inside the quiet window. Ranges that cross
 * midnight (e.g. 22:00 to 07:00) are supported.
 */
export function isInQuietHours(
  quiet: QuietHours,
  now: Date = new Date(),
): boolean {
  if (!quiet.enabled) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === null || end === null || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  if (start < end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

function labelsOf(segment: ReviewSegment): string[] {
  const data = segment.data;
  const labels = [...data.objects, ...data.audio, ...(data.sub_labels ?? [])];
  return Array.from(new Set(labels));
}

/**
 * Fold a `reviews` WebSocket message into the inbox. Returns true when the
 * store changed.
 */
export function ingestReview(review: FrigateReview | undefined): boolean {
  if (!review) return false;
  const segment = review.after;
  if (segment.severity !== "alert" && segment.severity !== "detection") {
    return false;
  }

  const existingIndex = state.items.findIndex((i) => i.id === segment.id);
  const settings = state.settings;

  if (existingIndex === -1) {
    // Only a review's start adds it. Updates and ends for a review the inbox
    // never saw are ignored, and so is anything the user dismissed or
    // cleared: the collector re-ingests the last message when it remounts.
    if (review.type !== "new" || dismissed.includes(segment.id)) {
      return false;
    }
    if (settings.mutedCameras.includes(segment.camera)) {
      return false;
    }
    const quiet = isInQuietHours(settings.quietHours);
    const item: InboxItem = {
      id: segment.id,
      camera: segment.camera,
      severity: segment.severity,
      labels: labelsOf(segment),
      zones: segment.data.zones,
      startTime: segment.start_time,
      endTime: segment.end_time,
      thumbPath: segment.thumb_path,
      read: quiet,
      receivedAt: Date.now(),
    };
    setItems([item, ...state.items]);
    return true;
  }

  const existing = state.items.at(existingIndex);
  if (existing === undefined) {
    return false;
  }
  const updated: InboxItem = {
    ...existing,
    severity: segment.severity,
    labels: labelsOf(segment),
    zones: segment.data.zones,
    endTime: segment.end_time ?? existing.endTime,
    thumbPath: segment.thumb_path || existing.thumbPath,
    // an escalation from detection to alert deserves a fresh badge unless
    // quiet hours apply
    read:
      existing.severity === "detection" && segment.severity === "alert"
        ? isInQuietHours(settings.quietHours)
        : existing.read,
  };
  const next = [...state.items];
  next[existingIndex] = updated;
  setItems(next);
  return true;
}

export function markInboxRead(id: string) {
  const next = state.items.map((item) =>
    item.id === id && !item.read ? { ...item, read: true } : item,
  );
  setItems(next);
}

export function markAllInboxRead() {
  if (state.items.every((item) => item.read)) return;
  setItems(state.items.map((item) => ({ ...item, read: true })));
}

export function removeInboxItem(id: string) {
  dismiss([id]);
  setItems(state.items.filter((item) => item.id !== id));
}

export function clearInbox() {
  dismiss(state.items.map((item) => item.id));
  setItems([]);
}

export function setCameraMuted(camera: string, muted: boolean) {
  const current = state.settings.mutedCameras;
  const next = muted
    ? Array.from(new Set([...current, camera]))
    : current.filter((c) => c !== camera);
  setSettings({ ...state.settings, mutedCameras: next });
}

export function setQuietHours(quietHours: QuietHours) {
  setSettings({ ...state.settings, quietHours });
}
