/**
 * Back-button stack for overlays (fork, flag `phoneFixes`).
 *
 * Upstream's `useHistoryBack` gives every open overlay its own `popstate`
 * listener. One back press therefore closes every open overlay at once, and
 * an overlay that closes itself calls `history.back()`, which the others
 * read as a back press and close too. Phones hit this constantly because
 * their menus open dialogs from drawers, and Android's back gesture is the
 * usual way to dismiss them.
 *
 * Here one listener serves every overlay: a back press closes only the
 * top-most one, and the `history.back()` calls this module makes to drop an
 * overlay's entry are skipped instead of being treated as back presses.
 *
 * Each overlay entry copies the router's state (react-router keeps view
 * state such as the open recording in `history.state`, not the URL), so
 * landing on an entry that was left behind shows the same view rather than
 * dropping it. An overlay only steps back when the current entry is still
 * its own: if anything navigated while it was open, even without changing
 * the URL, going back would undo that navigation.
 */

export type OverlayEntry = {
  /** Called when a back press dismisses this overlay. */
  close: () => void;
};

type HeldOverlay = { entry: OverlayEntry; id: number };
type OverlayState = { overlayOpen?: boolean; overlayId?: number };

const stack: HeldOverlay[] = [];
let nextId = 1;
let pendingSelfPops = 0;
let listening = false;

function onPopState() {
  if (pendingSelfPops > 0) {
    pendingSelfPops -= 1;
    return;
  }
  stack.pop()?.entry.close();
}

function currentState(): OverlayState | null {
  return window.history.state as OverlayState | null;
}

/** Push a history entry for a newly opened overlay. */
export function pushOverlay(entry: OverlayEntry): void {
  if (!listening) {
    window.addEventListener("popstate", onPopState);
    listening = true;
  }
  const id = nextId++;
  window.history.pushState(
    { ...(currentState() ?? {}), overlayOpen: true, overlayId: id },
    "",
  );
  stack.push({ entry, id });
}

/**
 * Forget an overlay that closed through its own UI or unmounted while open.
 *
 * Its history entry is dropped with `history.back()` only when the URL is
 * unchanged and the current entry is still the one it pushed. Otherwise
 * something navigated while it was open (a filter wrote search params, a
 * link inside it navigated, or a view stored state in history) and the
 * entry is left in place, because going back would undo that.
 */
export function releaseOverlay(entry: OverlayEntry, urlUnchanged: boolean) {
  let index = stack.length - 1;
  while (index >= 0 && stack[index]?.entry !== entry) {
    index -= 1;
  }
  if (index === -1) {
    return;
  }
  const [held] = stack.splice(index, 1);
  if (held && urlUnchanged && currentState()?.overlayId === held.id) {
    pendingSelfPops += 1;
    window.history.back();
  }
}

/** Number of overlays currently holding a history entry. */
export function openOverlayCount(): number {
  return stack.length;
}

/** Test helper: clear all state and detach the listener. */
export function resetOverlayHistory(): void {
  stack.length = 0;
  pendingSelfPops = 0;
  if (listening) {
    window.removeEventListener("popstate", onPopState);
    listening = false;
  }
}
