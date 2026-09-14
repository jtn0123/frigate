import {
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { usePersistence } from "./use-persistence";
import { useUserPersistence } from "./use-user-persistence";
import { AuthContext } from "@/context/auth-state";

export function useOverlayState<S>(
  key: string,
  defaultValue: S | undefined = undefined,
  preserveSearch: boolean = true,
): [
  S | undefined,
  (
    value: S,
    replace?: boolean,
    additionalState?: Record<string, unknown>,
  ) => void,
] {
  const location = useLocation();
  const navigate = useNavigate();

  const locationRef = useRef(location);
  locationRef.current = location;

  const setOverlayStateValue = useCallback(
    (
      value: S,
      replace: boolean = false,
      additionalState?: Record<string, unknown>,
    ) => {
      const loc = locationRef.current;
      const currentValue = loc.state?.[key] as S | undefined;

      if (Object.is(currentValue, value) && additionalState === undefined) {
        return;
      }

      // Related fields must be written together, before the next transition.
      const newLocationState = { ...loc.state, ...additionalState };
      newLocationState[key] = value;
      void navigate(loc.pathname + (preserveSearch ? loc.search : ""), {
        state: newLocationState,
        replace,
      });
    },
    // locationRef is stable so we don't need it in deps
    [key, navigate, preserveSearch],
  );

  const overlayStateValue = useMemo<S | undefined>(
    () => location.state && location.state[key],
    [location, key],
  );

  return [overlayStateValue ?? defaultValue, setOverlayStateValue];
}

export function usePersistedOverlayState<S extends string>(
  key: string,
  defaultValue: S | undefined = undefined,
): [
  S | undefined,
  (value: S | undefined, replace?: boolean) => void,
  boolean,
  () => void,
] {
  const location = useLocation();
  const navigate = useNavigate();

  const locationRef = useRef(location);
  locationRef.current = location;

  // currently selected value

  const overlayStateValue = useMemo<S | undefined>(
    () => location.state && location.state[key],
    [location, key],
  );

  // saved value from previous session

  const [persistedValue, setPersistedValue, loaded, deletePersistedValue] =
    usePersistence<S>(key, overlayStateValue);

  const setOverlayStateValue = useCallback(
    (value: S | undefined, replace: boolean = false) => {
      const loc = locationRef.current;
      const currentValue = loc.state?.[key] as S | undefined;

      if (Object.is(currentValue, value)) {
        return;
      }

      setPersistedValue(value);
      const newLocationState = { ...loc.state };
      newLocationState[key] = value;
      void navigate(loc.pathname, { state: newLocationState, replace });
    },
    // locationRef is stable so we don't need it in deps
    [key, navigate, setPersistedValue],
  );

  return [
    overlayStateValue ?? persistedValue ?? defaultValue,
    setOverlayStateValue,
    loaded,
    deletePersistedValue,
  ];
}

/**
 * Like usePersistedOverlayState, but namespaces the persistence key by username.
 * This ensures different users on the same browser don't share state.
 * Automatically migrates data from legacy (non-namespaced) keys on first use.
 */
export function useUserPersistedOverlayState<S extends string>(
  key: string,
  defaultValue: S | undefined = undefined,
): [
  S | undefined,
  (value: S | undefined, replace?: boolean) => void,
  boolean,
  () => void,
] {
  const { auth } = useContext(AuthContext);
  const location = useLocation();
  const navigate = useNavigate();

  const locationRef = useRef(location);
  locationRef.current = location;

  // currently selected value from URL state
  const overlayStateValue = useMemo<S | undefined>(
    () => location.state && location.state[key],
    [location, key],
  );

  // saved value from previous session (user-namespaced with migration)
  const [persistedValue, setPersistedValue, loaded, deletePersistedValue] =
    useUserPersistence<S>(key, overlayStateValue);

  const setOverlayStateValue = useCallback(
    (value: S | undefined, replace: boolean = false) => {
      const loc = locationRef.current;
      const currentValue = loc.state?.[key] as S | undefined;

      if (Object.is(currentValue, value)) {
        return;
      }

      setPersistedValue(value);
      const newLocationState = { ...loc.state };
      newLocationState[key] = value;
      void navigate(loc.pathname, { state: newLocationState, replace });
    },
    // locationRef is stable so we don't need it in deps
    [key, navigate, setPersistedValue],
  );

  // Don't return a value until auth has finished loading
  if (auth.isLoading) {
    return [undefined, setOverlayStateValue, false, deletePersistedValue];
  }

  return [
    overlayStateValue ?? persistedValue ?? defaultValue,
    setOverlayStateValue,
    loaded,
    deletePersistedValue,
  ];
}

export function useHashState<S extends string>(): [
  S | undefined,
  (value: S) => void,
] {
  const location = useLocation();
  const navigate = useNavigate();

  const locationRef = useRef(location);
  locationRef.current = location;

  const setHash = useCallback(
    (value: S | undefined) => {
      const loc = locationRef.current;
      const state: unknown = loc.state;
      if (!value) {
        void navigate(
          { pathname: loc.pathname, search: loc.search },
          { state },
        );
      } else {
        void navigate(
          { pathname: loc.pathname, search: loc.search, hash: `#${value}` },
          { state },
        );
      }
    },
    // locationRef is stable so we don't need it in deps
    [navigate],
  );

  const hash = useMemo(
    () => location.hash.substring(1) as unknown as S,
    [location.hash],
  );

  return [hash, setHash];
}

export function useSearchEffect(
  key: string,
  callback: (value: string) => boolean,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [pendingRemoval, setPendingRemoval] = useState(false);
  const processedRef = useRef<string | null>(null);

  // the strip navigate below has to read the location as it is when that
  // navigate actually runs: an async callback can write location state after
  // this effect's closure was created, and that state must not be clobbered
  const locationRef = useRef(location);
  locationRef.current = location;

  const currentParam = searchParams.get(key);

  // Process the param via callback (once per unique param value)
  useEffect(() => {
    if (currentParam == null || currentParam === processedRef.current) {
      return;
    }

    const decoded = decodeURIComponent(currentParam);
    const shouldRemove = callback(decoded);

    if (shouldRemove) {
      processedRef.current = currentParam;
      // react-router v7 wraps navigation in startTransition, so this flag has
      // to land in the same transition or it flushes before the callback's
      // navigation is reflected in location.state
      startTransition(() => setPendingRemoval(true));
    }
  }, [currentParam, callback, key]);

  // Remove the search param in a separate render cycle so that any state
  // changes from the callback (e.g., overlay state navigations) are already
  // reflected in location.state before we navigate to strip the param.
  useEffect(() => {
    if (!pendingRemoval) {
      return;
    }

    setPendingRemoval(false);
    const loc = locationRef.current;
    // react-router updates window.history synchronously but only re-renders
    // on a transition, so a callback that navigated (including asynchronously,
    // after this effect's render) may not be reflected in loc yet. The history
    // entry is the live value; stripping the param must not roll it back.
    // location.state is loosely typed upstream, so name the type here rather
    // than let it widen into the assignment
    const liveState: unknown =
      (window.history.state as { usr?: unknown } | null)?.usr ?? loc.state;
    void navigate(loc.pathname + loc.hash, {
      state: liveState,
      replace: true,
    });
    // locationRef is stable so we don't need it in deps
  }, [pendingRemoval, navigate]);

  // Reset tracking when param is removed from the URL
  useEffect(() => {
    if (currentParam == null) {
      processedRef.current = null;
    }
  }, [currentParam]);
}
