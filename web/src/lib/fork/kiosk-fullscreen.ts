/**
 * Page-level fullscreen for the wall display (UI19).
 *
 * The whole document goes fullscreen rather than one element, so it stays
 * fullscreen across the in-app navigation from Live's setup dialog to
 * `/kiosk`. Browsers only allow the request from a click or key press, and
 * deny it on some phones; every failure is ignored, since the display works
 * the same without it.
 */

/** The standard fullscreen API plus Safari's prefixed one, all optional. */
type FullscreenDocument = {
  fullscreenElement?: Element | null;
  fullscreenEnabled?: boolean;
  exitFullscreen?: () => Promise<void>;
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = {
  requestFullscreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => Promise<void> | void;
};

function api(): FullscreenDocument {
  return document;
}

export function isPageFullscreen(): boolean {
  return Boolean(api().fullscreenElement ?? api().webkitFullscreenElement);
}

export function supportsPageFullscreen(): boolean {
  return Boolean(api().fullscreenEnabled ?? api().webkitFullscreenEnabled);
}

export async function enterPageFullscreen(): Promise<void> {
  if (isPageFullscreen()) return;
  const root: FullscreenElement = document.documentElement;
  try {
    if (root.requestFullscreen) {
      await root.requestFullscreen();
    } else {
      await root.webkitRequestFullscreen?.();
    }
  } catch {
    // Denied (no user gesture, policy, or an unsupported phone): stay windowed.
  }
}

export async function exitPageFullscreen(): Promise<void> {
  if (!isPageFullscreen()) return;
  const page = api();
  try {
    if (page.exitFullscreen) {
      await page.exitFullscreen();
    } else {
      await page.webkitExitFullscreen?.();
    }
  } catch {
    // Already left, for example with the browser's own Esc handling.
  }
}

export async function togglePageFullscreen(): Promise<void> {
  if (isPageFullscreen()) {
    await exitPageFullscreen();
  } else {
    await enterPageFullscreen();
  }
}
