import { useEffect, useSyncExternalStore } from "react";
import type { IconType } from "react-icons";

// The full lucide set shipped by react-icons is roughly 800 kB before
// minification. Only two places need every icon: the camera group icon
// picker, and rendering an icon a user picked for a group. Everything else
// imports individual Lu* icons statically, which tree-shakes to a few kB.
//
// The picker's copy is loaded through the "react-icons-lu-all" alias (see
// vite.config.ts). It has to be a separate module id from "react-icons/lu":
// rollup would otherwise merge the dynamic import into the eager chunk that
// already holds the static icon imports and inline the whole library there.

export type IconName = keyof typeof import("react-icons/lu");
export type LuIconSet = Record<IconName, IconType>;

let icons: LuIconSet | undefined;
let pending: Promise<LuIconSet> | undefined;
const listeners = new Set<() => void>();

function collect(mod: Record<string, unknown>): LuIconSet {
  const source =
    mod.default && typeof mod.default === "object"
      ? { ...(mod.default as Record<string, unknown>), ...mod }
      : mod;
  const set: Record<string, IconType> = {};

  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith("Lu") && typeof value === "function") {
      set[name] = value as IconType;
    }
  }

  return set as LuIconSet;
}

export function loadLuIcons(): Promise<LuIconSet> {
  if (icons) {
    return Promise.resolve(icons);
  }

  pending ??= import("react-icons-lu-all")
    .then((mod) => {
      icons = collect(mod as Record<string, unknown>);
      listeners.forEach((listener) => listener());
      return icons;
    })
    .catch((error) => {
      // allow a retry on the next request instead of caching the failure
      pending = undefined;
      throw error;
    });

  return pending;
}

export function getLuIcons(): LuIconSet | undefined {
  return icons;
}

/**
 * True when `value` names an icon from react-icons/lu. Before the set has
 * been fetched this falls back to the naming pattern, which is enough to
 * decide whether fetching is worthwhile at all.
 */
export function isLuIconName(value: unknown): value is IconName {
  if (typeof value !== "string" || !/^Lu[A-Z]/.test(value)) {
    return false;
  }

  return icons ? value in icons : true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return icons;
}

/**
 * Returns the full icon set once it has loaded, kicking off the fetch when
 * `enabled` is true. Returns undefined while loading.
 */
export function useLuIcons(enabled: boolean = true): LuIconSet | undefined {
  const set = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (enabled && !set) {
      loadLuIcons().catch(() => {
        // the caller renders its placeholder until a later attempt succeeds
      });
    }
  }, [enabled, set]);

  return set;
}

/**
 * Resolves a single icon by name, fetching the set only when the name looks
 * like a valid icon.
 */
export function useLuIcon(name: string | undefined): IconType | undefined {
  const valid = isLuIconName(name);
  const set = useLuIcons(valid);

  if (!valid || !set) {
    return undefined;
  }

  return set[name];
}
