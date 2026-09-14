/**
 * Back button closes the top-most overlay (fork, flag `phoneFixes`).
 *
 * Same contract as upstream's `useHistoryBack`, backed by the shared stack
 * in `@/lib/fork/overlay-history` so nested overlays close one per back
 * press. `useHistoryOpenState` adds the open-state bookkeeping that
 * upstream's Dialog and Sheet do inline, for primitives that lack it
 * (vaul's Drawer, Radix's AlertDialog).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  pushOverlay,
  releaseOverlay,
  type OverlayEntry,
} from "@/lib/fork/overlay-history";

type UseOverlayHistoryBackOptions = {
  enabled: boolean;
  open: boolean;
  onClose: () => void;
};

// Unlike upstream this includes the hash: picking a camera from an overlay
// navigates to `/#camera`, and going back on close would undo that.
function currentUrl(): string {
  return (
    window.location.pathname + window.location.search + window.location.hash
  );
}

export function useOverlayHistoryBack({
  enabled,
  open,
  onClose,
}: UseOverlayHistoryBackOptions): void {
  // Keep onClose in a ref so a new callback identity does not re-push history
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!enabled || !open) {
      return;
    }

    const urlWhenOpened = currentUrl();
    let closedByBack = false;
    const entry: OverlayEntry = {
      close: () => {
        closedByBack = true;
        onCloseRef.current();
      },
    };
    pushOverlay(entry);

    // Runs when the overlay closes or unmounts while open
    return () => {
      if (!closedByBack) {
        releaseOverlay(entry, currentUrl() === urlWhenOpened);
      }
    };
  }, [enabled, open]);
}

type HistoryOpenStateOptions = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Controlled open state for an overlay root, closed by the back button.
 * Returns the `open` / `onOpenChange` pair to pass to the primitive.
 */
export function useHistoryOpenState({
  open,
  defaultOpen,
  onOpenChange,
}: HistoryOpenStateOptions): [boolean, (open: boolean) => void] {
  const [internalOpen, setInternalOpen] = useState(
    open ?? defaultOpen ?? false,
  );

  // Sync internal state with a controlled open prop
  useEffect(() => {
    if (open !== undefined) {
      setInternalOpen(open);
    }
  }, [open]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useOverlayHistoryBack({
    enabled: true,
    open: internalOpen,
    onClose: () => handleOpenChange(false),
  });

  return [internalOpen, handleOpenChange];
}
