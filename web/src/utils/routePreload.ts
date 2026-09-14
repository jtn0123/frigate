const loaders: Partial<Record<string, () => Promise<unknown>>> = {
  "/": () => import("@/pages/Live"),
  "/review": () => import("@/pages/Events"),
  "/explore": () => import("@/pages/Explore"),
  "/export": () => import("@/pages/Exports"),
  "/system": () => import("@/pages/System"),
  "/settings": () => import("@/pages/Settings"),
};
const pending = new Map<string, Promise<unknown>>();

type Connection = { saveData?: boolean; effectiveType?: string };

/** Respect the connection before speculative code or metadata requests. */
export function canPreloadRoute(): boolean {
  const connection = (navigator as Navigator & { connection?: Connection })
    .connection;
  return !(
    navigator.onLine === false ||
    connection?.saveData ||
    ["slow-2g", "2g", "3g"].includes(connection?.effectiveType ?? "")
  );
}

/** Warm a page module on explicit link intent. */
export function preloadRoute(path: string): void {
  if (!canPreloadRoute()) return;
  const pathname = path.split(/[?#]/)[0];
  const load = loaders[pathname];
  if (!load || pending.has(pathname)) return;
  const promise = load().catch(() => {
    // A later visit must be able to retry a failed speculative download.
    pending.delete(pathname);
  });
  pending.set(pathname, promise);
}
