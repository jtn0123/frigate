import { RefObject, useCallback, useEffect, useMemo, useState } from "react";
import { ScreenWakeLock } from "@/utils/screen-wake-lock";

function getFullscreenElement(): HTMLElement | null {
  return (
    document.fullscreenElement ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (document as any).webkitFullscreenElement ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (document as any).mozFullScreenElement ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (document as any).msFullscreenElement
  );
}

function exitFullscreen(): Promise<void> | null {
  if (document.exitFullscreen) return document.exitFullscreen();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((document as any).msExitFullscreen)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (document as any).msExitFullscreen();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((document as any).webkitExitFullscreen)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (document as any).webkitExitFullscreen();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((document as any).mozCancelFullScreen)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (document as any).mozCancelFullScreen();
  return null;
}

function enterFullScreen(element: HTMLElement): Promise<void> | null {
  if (element.requestFullscreen) return element.requestFullscreen();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((element as any).msRequestFullscreen)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (element as any).msRequestFullscreen();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((element as any).webkitEnterFullscreen)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (element as any).webkitEnterFullscreen();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((element as any).webkitRequestFullscreen)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (element as any).webkitRequestFullscreen();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((element as any).mozRequestFullscreen)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (element as any).mozRequestFullscreen();
  return null;
}

const prefixes = ["", "webkit", "moz", "ms"];

function addEventListeners(
  element: HTMLElement,
  onFullScreen: (event: Event) => void,
  onError: (event: Event) => void,
) {
  prefixes.forEach((prefix) => {
    element.addEventListener(`${prefix}fullscreenchange`, onFullScreen);
    element.addEventListener(`${prefix}fullscreenerror`, onError);
  });
}

function removeEventListeners(
  element: HTMLElement,
  onFullScreen: (event: Event) => void,
  onError: (event: Event) => void,
) {
  prefixes.forEach((prefix) => {
    element.removeEventListener(`${prefix}fullscreenchange`, onFullScreen);
    element.removeEventListener(`${prefix}fullscreenerror`, onError);
  });
}

export function useFullscreen<T extends HTMLElement = HTMLElement>(
  elementRef: RefObject<T | null>,
) {
  const [fullscreen, setFullscreen] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const wakeLock = useMemo(() => new ScreenWakeLock(), []);

  const handleFullscreenChange = useCallback(
    (event: Event) => {
      const active = event.target === getFullscreenElement();
      setFullscreen(active);
      if (!active) wakeLock.disable();
    },
    [wakeLock],
  );

  const handleFullscreenError = useCallback(
    (event: Event) => {
      wakeLock.disable();
      setFullscreen(false);
      setError(
        new Error(
          `Error attempting full-screen mode: ${event} (${event.target})`,
        ),
      );
    },
    [wakeLock],
  );

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!getFullscreenElement()) {
        wakeLock.enable();
        await enterFullScreen(elementRef.current!);
      } else {
        await exitFullscreen();
        wakeLock.disable();
      }
      setError(null);
    } catch (err) {
      wakeLock.disable();
      setError(err as Error);
    }
  }, [elementRef, wakeLock]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "F11") {
        void toggleFullscreen();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [toggleFullscreen]);

  useEffect(() => {
    const currentElement = elementRef.current;
    if (currentElement) {
      addEventListeners(
        currentElement,
        handleFullscreenChange,
        handleFullscreenError,
      );
      return () => {
        wakeLock.disable();
        removeEventListeners(
          currentElement,
          handleFullscreenChange,
          handleFullscreenError,
        );
      };
    }
  }, [elementRef, handleFullscreenChange, handleFullscreenError, wakeLock]);

  // compatibility

  const supportsFullScreen = useMemo<boolean>(() => {
    // @ts-expect-error we need to check that fullscreen exists
    if (document.exitFullscreen) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((document as any).msExitFullscreen) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((document as any).webkitExitFullscreen) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((document as any).mozCancelFullScreen) return true;
    return false;
  }, []);

  return {
    fullscreen,
    toggleFullscreen,
    supportsFullScreen,
    error,
    clearError,
  };
}
