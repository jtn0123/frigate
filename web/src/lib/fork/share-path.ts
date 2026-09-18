/**
 * Public clip-share URL helpers (UI11).
 *
 * Kept separate from the QR encoder so the eager app shell can detect
 * /share/:token without pulling the encoder into the main chunk.
 */

/** `window.baseUrl` with a trailing slash; "/" when Frigate is at the root. */
function basePath(): string {
  const rawBase = window.baseUrl || "/";
  return rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
}

export function sharePageUrl(
  token: string,
  origin = window.location.origin,
): string {
  return `${origin}${basePath()}share/${token}`;
}

/**
 * True only when the path IS the share route. Takes `window.location.pathname`
 * (which carries `window.baseUrl`) as well as the router's pathname (which
 * does not). Anchored, so a route that merely contains `/share/x` keeps its
 * login redirect instead of rendering the public shell.
 */
export function isPublicSharePath(pathname: string): boolean {
  const base = basePath();
  const path =
    base !== "/" && pathname.startsWith(base)
      ? pathname.slice(base.length - 1)
      : pathname;
  return /^\/share\/[^/]+\/?$/.test(path);
}

/**
 * Camera name for display. The public page has no config to read a friendly
 * name from, so this only undoes the underscores of the camera id.
 */
export function shareCameraName(camera: string): string {
  return camera.replaceAll("_", " ");
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
