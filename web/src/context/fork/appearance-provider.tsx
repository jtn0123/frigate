/**
 * Fork: appearance controls (UI item 15).
 *
 * Persists density, font scale and an OLED true-black toggle to localStorage
 * and applies them to <html> as `data-density`, the `--fork-font-scale`
 * custom property and an `oled` class. The CSS that consumes these lives in
 * `web/themes/fork-appearance.css`. Gated by the `themeControls` flag: when
 * the flag is off nothing is written to the document.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isForkEnabled } from "@/fork/flags";

export type Density = "comfortable" | "compact";
export type FontScale = 0.9 | 1 | 1.1 | 1.25;

// eslint-disable-next-line react-refresh/only-export-components
export const densities: Density[] = ["comfortable", "compact"];
// eslint-disable-next-line react-refresh/only-export-components
export const fontScales: FontScale[] = [0.9, 1, 1.1, 1.25];

export type AppearanceState = {
  density: Density;
  fontScale: FontScale;
  oled: boolean;
};

type AppearanceContextValue = AppearanceState & {
  enabled: boolean;
  setDensity: (density: Density) => void;
  setFontScale: (scale: FontScale) => void;
  setOled: (oled: boolean) => void;
};

const STORAGE_KEY = "frigate-fork-appearance";

const defaults: AppearanceState = {
  density: "comfortable",
  fontScale: 1,
  oled: false,
};

const AppearanceContext = createContext<AppearanceContextValue>({
  ...defaults,
  enabled: false,
  setDensity: () => null,
  setFontScale: () => null,
  setOled: () => null,
});

function readStored(): AppearanceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<AppearanceState>;
    return {
      density: densities.includes(parsed.density as Density)
        ? (parsed.density as Density)
        : defaults.density,
      fontScale: fontScales.includes(parsed.fontScale as FontScale)
        ? (parsed.fontScale as FontScale)
        : defaults.fontScale,
      oled: typeof parsed.oled === "boolean" ? parsed.oled : defaults.oled,
    };
  } catch {
    return defaults;
  }
}

function applyToDocument(state: AppearanceState) {
  const root = document.documentElement;
  root.dataset.density = state.density;
  root.style.setProperty("--fork-font-scale", String(state.fontScale));
  root.classList.toggle("oled", state.oled);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const enabled = isForkEnabled("themeControls");
  const [state, setState] = useState<AppearanceState>(() =>
    enabled ? readStored() : defaults,
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    applyToDocument(state);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage can be unavailable (private mode, quota); the in-memory
      // state still drives the document so the session keeps working.
    }
  }, [enabled, state]);

  const setDensity = useCallback(
    (density: Density) => setState((prev) => ({ ...prev, density })),
    [],
  );
  const setFontScale = useCallback(
    (fontScale: FontScale) => setState((prev) => ({ ...prev, fontScale })),
    [],
  );
  const setOled = useCallback(
    (oled: boolean) => setState((prev) => ({ ...prev, oled })),
    [],
  );

  const value = useMemo<AppearanceContextValue>(
    () => ({ ...state, enabled, setDensity, setFontScale, setOled }),
    [state, enabled, setDensity, setFontScale, setOled],
  );

  return <AppearanceContext value={value}>{children}</AppearanceContext>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppearance() {
  return useContext(AppearanceContext);
}
