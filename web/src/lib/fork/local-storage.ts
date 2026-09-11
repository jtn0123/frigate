/**
 * Small, safe localStorage JSON helpers shared by fork features.
 *
 * Every access is wrapped so private browsing modes, quota errors, or a
 * corrupted value never throw into React render paths.
 */

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota and privacy-mode failures
  }
}
