import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LAST_SEEN_KEY,
  currentRelease,
  newerReleases,
  readLastSeen,
  releaseVersion,
  splitUnderTheHood,
  unseenReleases,
  writeLastSeen,
  type ForkRelease,
  type ForkUpdateState,
} from "./updates";

function release(n: number): ForkRelease {
  return {
    tag: `fork/0.18.0-rc2-2026091${n}.${n}`,
    name: `0.18.0-rc2-2026091${n}.${n}`,
    sha: String(n).repeat(40),
    published_at: `2026-09-1${n}T12:00:00Z`,
    url: `https://github.com/jtn0123/frigate/releases/tag/fork/${n}`,
    notes: `- Change ${n}`,
  };
}

// Newest first, as the backend returns them.
const RELEASES = [release(4), release(3), release(2), release(1)];

function state(overrides: Partial<ForkUpdateState> = {}): ForkUpdateState {
  return {
    status: "up-to-date",
    repo: "jtn0123/frigate",
    current_version: "0.18.0-3333333",
    current_sha: "3333333",
    current_tag: RELEASES[1]!.tag,
    latest_tag: RELEASES[0]!.tag,
    newer_count: 0,
    releases: RELEASES,
    checked_at: 1,
    error: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("newerReleases", () => {
  it("lists releases above the running one when an update is available", () => {
    const tags = newerReleases(
      state({ status: "available", newer_count: 1 }),
    ).map((r) => r.tag);
    expect(tags).toEqual([RELEASES[0]!.tag]);
  });

  it("is empty for every other status", () => {
    expect(newerReleases(undefined)).toEqual([]);
    expect(newerReleases(state({ newer_count: 1 }))).toEqual([]);
    expect(newerReleases(state({ status: "development" }))).toEqual([]);
  });
});

describe("unseenReleases", () => {
  it("shows every release after the last seen one, newest first", () => {
    const tags = unseenReleases(state(), RELEASES[3]!.tag).map((r) => r.tag);
    expect(tags).toEqual([RELEASES[1]!.tag, RELEASES[2]!.tag]);
  });

  it("shows only the running release on a first visit", () => {
    const tags = unseenReleases(state(), null).map((r) => r.tag);
    expect(tags).toEqual([RELEASES[1]!.tag]);
  });

  it("shows only the running release when the last seen one is gone", () => {
    const tags = unseenReleases(state(), "fork/ancient").map((r) => r.tag);
    expect(tags).toEqual([RELEASES[1]!.tag]);
  });

  it("shows nothing once the running release was seen, or after a rollback", () => {
    expect(unseenReleases(state(), RELEASES[1]!.tag)).toEqual([]);
    expect(unseenReleases(state(), RELEASES[0]!.tag)).toEqual([]);
  });

  it("shows nothing for a build that is not a release", () => {
    expect(
      unseenReleases(state({ status: "development", current_tag: null }), null),
    ).toEqual([]);
  });
});

describe("helpers", () => {
  it("finds the running release and strips the tag prefix", () => {
    expect(currentRelease(state())?.tag).toBe(RELEASES[1]!.tag);
    expect(currentRelease(state({ current_tag: null }))).toBeUndefined();
    expect(releaseVersion("fork/0.18.0-rc2-20260911.1")).toBe(
      "0.18.0-rc2-20260911.1",
    );
    expect(releaseVersion(null)).toBe("");
  });

  it("remembers the last seen release in localStorage", () => {
    expect(readLastSeen()).toBeNull();
    writeLastSeen("fork/x");
    expect(localStorage.getItem(LAST_SEEN_KEY)).toBe("fork/x");
    expect(readLastSeen()).toBe("fork/x");
  });

  it("survives unavailable storage", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readLastSeen()).toBeNull();
    expect(() => writeLastSeen("fork/x")).not.toThrow();
  });
});

describe("splitUnderTheHood", () => {
  it("separates the tooling list from the main notes", () => {
    const { main, hood } = splitUnderTheHood(
      "### New\n\n- Kiosk mode\n\n### Under the hood (2)\n\n- Ratchet\n- Lint",
    );
    expect(main).toBe("### New\n\n- Kiosk mode");
    expect(hood).toEqual({
      title: "Under the hood (2)",
      body: "- Ratchet\n- Lint",
    });
  });

  it("leaves notes without the section alone", () => {
    expect(splitUnderTheHood("- Only this")).toEqual({
      main: "- Only this",
      hood: null,
    });
  });
});
