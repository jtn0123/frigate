/**
 * Fork (E26): pure helpers for the signed-in sessions list.
 *
 * The server stores the raw user agent of each sign-in; this turns it into
 * something a person recognizes ("Chrome on macOS", "Home Assistant") and
 * orders the list so the session being used right now comes first.
 *
 * Browser, system and client names are product names and are not
 * translated; the sentence around them is (see the `sessions` keys in the
 * fork namespace).
 */

export type SessionDeviceKind = "desktop" | "phone" | "tablet" | "app";

export type SessionDevice = {
  kind: SessionDeviceKind | "unknown";
  /** Browser name, for a browser session. */
  browser?: string;
  /** Operating system, when the user agent names one. */
  os?: string;
  /** Client name, for an integration or script rather than a browser. */
  app?: string;
};

/** A session as `GET /fork/sessions` lists it. */
export type SessionLike = {
  id: string;
  username: string;
  last_seen: number;
  current: boolean;
};

/** Activity within this many seconds reads as "Active now". */
export const ACTIVE_NOW_SECONDS = 120;

// Clients that are not browsers, most specific first. Home Assistant's
// integration sends "HomeAssistant/<version> aiohttp/<version> ...", its
// companion apps "Home Assistant/<version> (...)".
const APPS: ReadonlyArray<[RegExp, string]> = [
  [/home ?assistant/i, "Home Assistant"],
  [/python-requests\//i, "Python requests"],
  [/aiohttp\//i, "aiohttp"],
  [/^curl\//i, "curl"],
  [/^wget\//i, "Wget"],
  [/go-http-client\//i, "Go HTTP client"],
  [/okhttp\//i, "OkHttp"],
  [/^node|axios\//i, "Node.js"],
  [/^postmanruntime\//i, "Postman"],
];

// Order matters: Edge and Opera also say Chrome, Chrome also says Safari.
const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/edg(e|a|ios)?\//i, "Edge"],
  [/(opr|opera)\//i, "Opera"],
  [/samsungbrowser\//i, "Samsung Internet"],
  [/(firefox|fxios)\//i, "Firefox"],
  [/(chrome|crios|chromium)\//i, "Chrome"],
  [/version\/[\d.]+.*safari\//i, "Safari"],
];

function detectOs(ua: string): { os?: string; kind?: SessionDeviceKind } {
  if (/ipad/i.test(ua)) {
    return { os: "iPadOS", kind: "tablet" };
  }
  if (/iphone|ipod/i.test(ua)) {
    return { os: "iOS", kind: "phone" };
  }
  if (/\bios\b/i.test(ua)) {
    return { os: "iOS", kind: "phone" };
  }
  if (/android/i.test(ua)) {
    // Android tablets leave "Mobile" out of the browser's user agent
    return { os: "Android", kind: /mobile/i.test(ua) ? "phone" : "tablet" };
  }
  if (/cros/i.test(ua)) {
    return { os: "ChromeOS", kind: "desktop" };
  }
  if (/mac os x|macintosh/i.test(ua)) {
    return { os: "macOS", kind: "desktop" };
  }
  if (/windows/i.test(ua)) {
    return { os: "Windows", kind: "desktop" };
  }
  if (/linux|x11/i.test(ua)) {
    return { os: "Linux", kind: "desktop" };
  }
  return {};
}

/** Describe the device behind a user agent string. */
export function parseUserAgent(
  userAgent: string | null | undefined,
): SessionDevice {
  const ua = (userAgent ?? "").trim();
  if (!ua) {
    return { kind: "unknown" };
  }

  const { os, kind } = detectOs(ua);

  for (const [pattern, app] of APPS) {
    if (pattern.test(ua)) {
      return { kind: "app", app, ...(os ? { os } : {}) };
    }
  }

  if (/^mozilla\//i.test(ua)) {
    const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
    return {
      kind: kind ?? "desktop",
      ...(browser ? { browser } : {}),
      ...(os ? { os } : {}),
    };
  }

  // some other program: name it by its first product token
  const product = /^([A-Za-z][\w.-]*)\//.exec(ua)?.[1];
  return product ? { kind: "app", app: product } : { kind: "unknown" };
}

/** Whether a session counts as in use right now. */
export function isActiveNow(lastSeen: number, now: number): boolean {
  return now - lastSeen < ACTIVE_NOW_SECONDS;
}

export type SessionAge =
  { unit: "now" } | { unit: "minutes" | "hours" | "days"; count: number };

/**
 * How long ago `at` was, in the largest whole unit, for "Active 5 minutes
 * ago" and "Signed in 2 days ago". Anything under `nowWithin` seconds, or
 * in the future (a clock a little ahead of the server's), reads as now.
 */
export function sessionAge(
  at: number,
  now: number,
  nowWithin: number = 60,
): SessionAge {
  const seconds = now - at;
  if (seconds < nowWithin) {
    return { unit: "now" };
  }
  if (seconds < 3600) {
    return { unit: "minutes", count: Math.max(1, Math.floor(seconds / 60)) };
  }
  if (seconds < 86400) {
    return { unit: "hours", count: Math.floor(seconds / 3600) };
  }
  return { unit: "days", count: Math.floor(seconds / 86400) };
}

/** The caller's own session first, then the most recently active. */
export function sortSessions<T extends SessionLike>(
  sessions: readonly T[],
): T[] {
  return [...sessions].sort((a, b) => {
    if (a.current !== b.current) {
      return a.current ? -1 : 1;
    }
    return b.last_seen - a.last_seen;
  });
}

export type SessionGroup<T extends SessionLike> = {
  username: string;
  sessions: T[];
};

/**
 * Sessions grouped by user: the signed-in user's own group first, the rest
 * by name. Each group is ordered by `sortSessions`.
 */
export function groupSessionsByUser<T extends SessionLike>(
  sessions: readonly T[],
  currentUser: string | null | undefined,
): SessionGroup<T>[] {
  const byUser = new Map<string, T[]>();
  for (const session of sessions) {
    const group = byUser.get(session.username) ?? [];
    group.push(session);
    byUser.set(session.username, group);
  }

  return [...byUser.entries()]
    .sort(([a], [b]) => {
      if (a === currentUser || b === currentUser) {
        return a === currentUser ? -1 : 1;
      }
      return a.localeCompare(b);
    })
    .map(([username, group]) => ({ username, sessions: sortSessions(group) }));
}

const IPV4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/i;

/**
 * Whether an address is one only a local network uses: loopback, link-local,
 * RFC 1918, carrier-grade NAT and IPv6 unique local. A proxy or Docker's
 * network gateway sits on one of these.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = IPV4.exec(ip.trim());
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.trim().toLowerCase();
  return (
    v6 === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab]/.test(v6)
  );
}

/**
 * The one private address every session came from, or null. When all of
 * them share it, it is the address of whatever forwards the requests (a
 * reverse proxy, or Docker's network on Docker Desktop), not the devices'.
 * One session alone says nothing, so it takes two.
 */
export function sharedProxyAddress(
  sessions: ReadonlyArray<{ ip: string }>,
): string | null {
  const first = sessions[0]?.ip;
  if (
    sessions.length < 2 ||
    !first ||
    sessions.some((session) => session.ip !== first)
  ) {
    return null;
  }
  return isPrivateAddress(first) ? first : null;
}

/** Sessions that "Sign out other sessions" would end. */
export function otherSessions<T extends SessionLike>(
  sessions: readonly T[],
): T[] {
  return sessions.filter((session) => !session.current);
}
