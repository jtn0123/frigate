/**
 * Fork feature flags.
 *
 * Every behaviour this fork adds on top of upstream Frigate is gated by a
 * flag here so upstream code paths stay byte-identical when a flag is off.
 * Keep this file tiny and dependency-free: it is imported from the app shell.
 *
 * Flags default on for the fork build. To disable one at runtime set
 * `localStorage.frigateFork = '{"commandPalette":false}'` and reload.
 */

export type ForkFlags = {
  /** Route-level error boundary with a reload panel instead of a blank page. */
  errorBoundary: boolean;
  /** Toast for read-path (SWR) failures, not just mutations. */
  readErrorToasts: boolean;
  /** Cmd/Ctrl+K palette for cameras, pages, and settings. */
  commandPalette: boolean;
  /** Density / font scale / OLED-black theme controls. */
  themeControls: boolean;
  /** Per-camera health cards on the System page. */
  cameraHealth: boolean;
  /** System health notices alongside the fork camera history. */
  systemNotices: boolean;
  /** In-app notification inbox with quiet hours. */
  notificationInbox: boolean;
  /** Multi-select and bulk actions in Review and Explore. */
  bulkActions: boolean;
  /** One-click share links for clips. */
  clipSharing: boolean;
  /** Saved live layouts per device and touch-friendly resize. */
  liveLayoutMemory: boolean;
  /** Sticky section nav, dirty indicators, and restart badges in Settings. */
  settingsNav: boolean;
  /** Snap-to-event, keyboard step, and larger touch targets on the timeline. */
  timelineScrubber: boolean;
  /** Shared event detail panel for Review and Explore. */
  unifiedEventDetail: boolean;
  /** Viewport-driven responsive layout instead of user-agent sniffing. */
  viewportLayout: boolean;
  /** Update button and What's new from the fork's GitHub releases. */
  updateNotices: boolean;
  /** Phone fixes: back closes overlays, insets, landscape, fullscreen. */
  phoneFixes: boolean;
  /** Tracking overlay: tap pauses on the moment, box between moments, edge dots faded. */
  trackOverlay: boolean;
  /** Suggested class from the event description on the classification train grid. */
  classificationSuggestions: boolean;
  /** Spotlights page: a ranked feed of the activity worth a look. */
  spotlights: boolean;
  /** Live bitrate, viewer and detector latency cards on the System page. */
  liveTelemetry: boolean;
  /** Multi-camera grid in the recording view, every tile on one clock. */
  syncedPlayback: boolean;
  /** Chrome-free wall display at /kiosk that cycles camera groups. */
  kioskMode: boolean;
};

const defaults: ForkFlags = {
  errorBoundary: true,
  readErrorToasts: true,
  commandPalette: true,
  themeControls: true,
  cameraHealth: true,
  systemNotices: true,
  notificationInbox: true,
  bulkActions: true,
  clipSharing: true,
  liveLayoutMemory: true,
  settingsNav: true,
  timelineScrubber: true,
  unifiedEventDetail: true,
  viewportLayout: true,
  updateNotices: true,
  phoneFixes: true,
  trackOverlay: true,
  classificationSuggestions: true,
  spotlights: true,
  liveTelemetry: true,
  syncedPlayback: true,
  kioskMode: true,
};

function readOverrides(): Partial<ForkFlags> {
  try {
    const raw = globalThis.localStorage.getItem("frigateFork");
    return raw ? (JSON.parse(raw) as Partial<ForkFlags>) : {};
  } catch {
    return {};
  }
}

export const forkFlags: Readonly<ForkFlags> = Object.freeze({
  ...defaults,
  ...readOverrides(),
});

export function isForkEnabled(flag: keyof ForkFlags): boolean {
  return forkFlags[flag];
}
