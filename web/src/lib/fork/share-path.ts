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
