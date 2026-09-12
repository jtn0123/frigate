/**
 * Fork update state for GET /api/fork/updates (UI42).
 *
 * The default is a development build with no releases, so neither the update
 * button nor What's new appears unless a spec asks for them.
 */

export interface ForkReleaseMock {
  tag: string;
  name: string;
  sha: string;
  published_at: string;
  url: string;
  notes: string;
}

export interface ForkUpdatesMock {
  status: "disabled" | "unknown" | "development" | "up-to-date" | "available";
  repo: string;
  current_version: string;
  current_sha: string | null;
  current_tag: string | null;
  latest_tag: string | null;
  newer_count: number;
  releases: ForkReleaseMock[];
  checked_at: number | null;
  error: string | null;
}

/** A release named `version`, tagged `fork/<version>`. */
export function forkRelease(
  version: string,
  notes: string,
  sha = "0".repeat(40),
): ForkReleaseMock {
  return {
    tag: `fork/${version}`,
    name: version,
    sha,
    published_at: "2026-09-11T12:00:00Z",
    url: `https://github.com/jtn0123/frigate/releases/tag/fork/${version}`,
    notes,
  };
}

export function forkUpdatesFactory(
  overrides?: Partial<ForkUpdatesMock>,
): ForkUpdatesMock {
  return {
    status: "development",
    repo: "jtn0123/frigate",
    current_version: "0.18.0-0000000",
    current_sha: "0000000",
    current_tag: null,
    latest_tag: null,
    newer_count: 0,
    releases: [],
    checked_at: 1_789_000_000,
    error: null,
    ...overrides,
  };
}
