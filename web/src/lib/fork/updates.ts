/**
 * Fork update notices (UI42): pure helpers over GET /api/fork/updates.
 *
 * The backend lists the fork's GitHub releases newest first and says which
 * one this build is. "Available" is every release above it; "What's new" is
 * every release between the one this browser last saw and the running one.
 */

export type ForkRelease = {
  tag: string;
  name: string;
  sha: string;
  published_at: string;
  url: string;
  notes: string;
};

export type ForkUpdateStatus =
  "disabled" | "unknown" | "development" | "up-to-date" | "available";

export type ForkUpdateState = {
  status: ForkUpdateStatus;
  repo: string;
  current_version: string;
  current_sha: string | null;
  current_tag: string | null;
  latest_tag: string | null;
  newer_count: number;
  releases: ForkRelease[];
  checked_at: number | null;
  error: string | null;
};

/** "update" lists newer releases; "whatsNew" the ones this browser missed. */
export type ReleaseNotesMode = "update" | "whatsNew";

/** localStorage key holding the release tag this browser last showed. */
export const LAST_SEEN_KEY = "frigateFork.lastSeenRelease";

/** Window event that opens What's new (the command palette sends it). */
export const WHATS_NEW_EVENT = "frigate-fork:whats-new";

/** Releases newer than the running build, newest first. */
export function newerReleases(
  state: ForkUpdateState | undefined,
): ForkRelease[] {
  if (!state || state.status !== "available") {
    return [];
  }
  return state.releases.slice(0, state.newer_count);
}

/** The release this build was published as, if it is one. */
export function currentRelease(
  state: ForkUpdateState | undefined,
): ForkRelease | undefined {
  if (!state?.current_tag) {
    return undefined;
  }
  return state.releases.find((release) => release.tag === state.current_tag);
}

/**
 * Releases What's new should show, newest first: everything after `lastSeen`
 * up to the running release. A first visit, or a last-seen release that fell
 * off the list, shows just the running one. A rollback (last seen is newer
 * than what runs now) shows nothing.
 */
export function unseenReleases(
  state: ForkUpdateState | undefined,
  lastSeen: string | null,
): ForkRelease[] {
  if (!state?.current_tag || lastSeen === state.current_tag) {
    return [];
  }
  const current = state.releases.findIndex(
    (release) => release.tag === state.current_tag,
  );
  if (current < 0) {
    return [];
  }
  const seen = lastSeen
    ? state.releases.findIndex((release) => release.tag === lastSeen)
    : -1;
  if (seen < 0) {
    return state.releases.slice(current, current + 1);
  }
  if (seen < current) {
    return [];
  }
  return state.releases.slice(current, seen);
}

/** A release tag without its `fork/` prefix, for display. */
export function releaseVersion(tag: string | null | undefined): string {
  return (tag ?? "").replace(/^fork\//, "");
}

// The heading the backend turns the folded "Under the hood" block into.
const UNDER_THE_HOOD = /^### Under the hood.*$/m;

/** Split notes into the main list and the tooling list the dialog folds. */
export function splitUnderTheHood(notes: string): {
  main: string;
  hood: { title: string; body: string } | null;
} {
  const match = UNDER_THE_HOOD.exec(notes);
  if (!match) {
    return { main: notes, hood: null };
  }
  return {
    main: notes.slice(0, match.index).trim(),
    hood: {
      title: match[0].replace(/^### /, ""),
      body: notes.slice(match.index + match[0].length).trim(),
    },
  };
}

export function readLastSeen(): string | null {
  try {
    return globalThis.localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

export function writeLastSeen(tag: string): void {
  try {
    globalThis.localStorage.setItem(LAST_SEEN_KEY, tag);
  } catch {
    // Storage can be unavailable (private mode); What's new then shows again.
  }
}
