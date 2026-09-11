/**
 * Fork: toast for read-path (SWR) failures (report item C5).
 *
 * Upstream toasts on mutations but reads fail silently. `reportReadError`
 * is called from the global SWRConfig `onError` for anything that is not an
 * auth redirect. It is de-duplicated per SWR key with a cooldown so a
 * polling hook that keeps failing does not stack toasts, and it is gated by
 * the `readErrorToasts` fork flag.
 */

import { t } from "i18next";
import { toast } from "sonner";
import { isForkEnabled } from "@/fork/flags";

export const READ_ERROR_COOLDOWN_MS = 30_000;

const lastShown = new Map<string, number>();

/**
 * sonner drops a toast dispatched while no <Toaster> is mounted, and
 * upstream mounts Toasters per page rather than at the shell, so a failure
 * during a lazy page load (or on a page without one) would vanish. The ui
 * Toaster wrapper registers itself here; while none is mounted the toast is
 * queued and flushed by the next one to mount.
 */
let mountedToasters = 0;
const pending: Array<() => void> = [];

export function registerToaster(): () => void {
  mountedToasters += 1;
  const queued = pending.splice(0, pending.length);
  for (const show of queued) {
    show();
  }
  return () => {
    mountedToasters -= 1;
  };
}

/**
 * Collapse an SWR key to the request path so `["review", {...params}]`
 * variants of the same endpoint share one cooldown bucket.
 */
export function readErrorKeyId(key: unknown): string {
  if (typeof key === "string") {
    // SWR hands onError the serialised key; array keys arrive as
    // `@"path",#param:"value",` so pull the path back out.
    const serialised = /^@"([^"]*)"/.exec(key);
    return serialised ? serialised[1] : key;
  }
  if (Array.isArray(key) && key.length > 0) {
    return String(key[0]);
  }
  try {
    return JSON.stringify(key) ?? String(key);
  } catch {
    return String(key);
  }
}

function serverMessage(error: unknown): string | undefined {
  const err = error as {
    response?: { data?: { message?: unknown; detail?: unknown } };
    message?: unknown;
  };
  const candidates = [
    err.response?.data?.message,
    err.response?.data?.detail,
    err.message,
  ];
  const found = candidates.find(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  return typeof found === "string" ? found : undefined;
}

/**
 * Upstream answers 404 when a lookup has nothing yet, and the pages already
 * render that as empty. It is not a failure, so it gets no toast.
 * - preview/*: no preview frames yet
 * - review/event/*: Explore detail asks for a review item that often
 *   does not exist for a standalone tracked object
 */
function isEmptyResult(id: string, status: number | undefined): boolean {
  return (
    status === 404 &&
    (id.startsWith("preview/") || id.startsWith("review/event/"))
  );
}

/** Test hook: forget every cooldown so the next failure toasts again. */
export function resetReadErrorCooldowns(): void {
  lastShown.clear();
}

export function reportReadError(error: unknown, key: unknown): void {
  if (!isForkEnabled("readErrorToasts")) {
    return;
  }

  const id = readErrorKeyId(key);
  const status = (error as { response?: { status?: number } })?.response
    ?.status;
  if (isEmptyResult(id, status)) {
    return;
  }

  const now = Date.now();
  const previous = lastShown.get(id);
  if (previous !== undefined && now - previous < READ_ERROR_COOLDOWN_MS) {
    return;
  }
  lastShown.set(id, now);

  const title = status
    ? t("readError.withStatus", { ns: "fork", resource: id, status })
    : t("readError.network", { ns: "fork", resource: id });

  const show = () =>
    toast.error(title, {
      id: `fork-read-error-${id}`,
      description: serverMessage(error),
      position: "top-center",
    });

  if (mountedToasters === 0) {
    pending.push(show);
    return;
  }
  show();
}
