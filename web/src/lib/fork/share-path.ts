/**
 * Public clip-share URL helpers (UI11).
 *
 * Kept separate from the QR encoder so the eager app shell can detect
 * /share/:token without pulling the encoder into the main chunk.
 */

export function sharePageUrl(
  token: string,
  origin = window.location.origin,
): string {
  const rawBase = window.baseUrl || "/";
  const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
  return `${origin}${base}share/${token}`;
}

export function isPublicSharePath(pathname: string): boolean {
  return /(?:^|\/)share\/[^/]+/.test(pathname);
}

/** Same shape the server accepts (`TOKEN_RE` in frigate/api/fork_share.py). */
const SHARE_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

export function isShareToken(value: string | undefined): value is string {
  return value !== undefined && SHARE_TOKEN.test(value);
}

export type ShareExpiry = {
  unit: "minutes" | "hours" | "days";
  count: number;
};

/** Time left on a link, in the largest unit that is at least 1 (rounded down). */
export function shareExpiry(expiresAt: number, now: number): ShareExpiry {
  const minutes = Math.max(0, Math.floor((expiresAt - now) / 60));
  if (minutes < 60) {
    return { unit: "minutes", count: minutes };
  }
  if (minutes < 48 * 60) {
    return { unit: "hours", count: Math.floor(minutes / 60) };
  }
  return { unit: "days", count: Math.floor(minutes / (24 * 60)) };
}
