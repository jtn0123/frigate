import { useCallback, useEffect, useSyncExternalStore } from "react";
import { readJson, writeJson } from "@/lib/fork/local-storage";

// Module level open state so any trigger (sidebar button, bottombar button,
// keyboard shortcut) can open the single palette mounted from App.tsx.
let paletteOpen = false;
const openListeners = new Set<() => void>();

export function setCommandPaletteOpen(open: boolean) {
  if (paletteOpen === open) return;
  paletteOpen = open;
  for (const listener of Array.from(openListeners)) listener();
}

function subscribeOpen(listener: () => void) {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

export function useCommandPaletteOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(subscribeOpen, () => paletteOpen);
  return [open, setCommandPaletteOpen];
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * Cmd/Ctrl+K toggles the palette anywhere. "/" opens it when no text field
 * is focused (so typing in inputs and the config editor is unaffected).
 */
export function useCommandPaletteShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        setCommandPaletteOpen(!paletteOpen);
        return;
      }
      if (
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !paletteOpen &&
        !isTypingTarget(e.target)
      ) {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

// Recent items, persisted so the palette opens on what the user did last.
const RECENT_KEY = "frigateFork.recentCommands";
const RECENT_MAX = 8;

let recentIds: string[] = readJson<string[]>(RECENT_KEY, []);
const recentListeners = new Set<() => void>();

function subscribeRecent(listener: () => void) {
  recentListeners.add(listener);
  return () => {
    recentListeners.delete(listener);
  };
}

export function useRecentCommands(): [string[], (id: string) => void] {
  const recent = useSyncExternalStore(subscribeRecent, () => recentIds);
  const push = useCallback((id: string) => {
    recentIds = [id, ...recentIds.filter((r) => r !== id)].slice(0, RECENT_MAX);
    writeJson(RECENT_KEY, recentIds);
    for (const listener of Array.from(recentListeners)) listener();
  }, []);
  return [recent, push];
}
