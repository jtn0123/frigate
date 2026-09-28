import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openOverlayCount,
  pushOverlay,
  releaseOverlay,
  resetOverlayHistory,
} from "./overlay-history";

// jsdom delivers popstate asynchronously, so wait for the navigation itself.
function waitForPopstate(action: () => void): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
    action();
  });
}

function pressBack(): Promise<void> {
  return waitForPopstate(() => window.history.back());
}

describe("overlay history stack", () => {
  afterEach(() => {
    resetOverlayHistory();
  });

  it("closes only the top-most overlay on back", async () => {
    const drawer = { close: vi.fn() };
    const dialog = { close: vi.fn() };
    pushOverlay(drawer);
    pushOverlay(dialog);

    await pressBack();
    expect(dialog.close).toHaveBeenCalledTimes(1);
    expect(drawer.close).not.toHaveBeenCalled();

    await pressBack();
    expect(drawer.close).toHaveBeenCalledTimes(1);
    expect(openOverlayCount()).toBe(0);
  });

  it("does not treat its own history.back() as a back press", async () => {
    const drawer = { close: vi.fn() };
    const dialog = { close: vi.fn() };
    pushOverlay(drawer);
    pushOverlay(dialog);

    // The dialog closes through its own button
    await waitForPopstate(() => releaseOverlay(dialog, true));
    expect(drawer.close).not.toHaveBeenCalled();
    expect(openOverlayCount()).toBe(1);

    await pressBack();
    expect(drawer.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the history entry when the URL moved on", () => {
    const back = vi.spyOn(window.history, "back");
    const drawer = { close: vi.fn() };
    pushOverlay(drawer);
    releaseOverlay(drawer, false);
    expect(back).not.toHaveBeenCalled();
    expect(openOverlayCount()).toBe(0);
    back.mockRestore();
  });

  it("keeps the router's state on the overlay entry", () => {
    window.history.replaceState({ usr: { recording: "front_door" } }, "");
    pushOverlay({ close: vi.fn() });
    expect(window.history.state).toMatchObject({
      usr: { recording: "front_door" },
      overlayOpen: true,
    });
  });

  it("does not go back when a view navigated while it was open", () => {
    const back = vi.spyOn(window.history, "back");
    const drawer = { close: vi.fn() };
    pushOverlay(drawer);
    // A state-only navigation (same URL), like choosing a timeline mode
    window.history.pushState({ usr: { timelineType: "detail" } }, "");
    releaseOverlay(drawer, true);
    expect(back).not.toHaveBeenCalled();
    expect(openOverlayCount()).toBe(0);
    back.mockRestore();
  });

  it("ignores a release for an overlay it does not hold", () => {
    const stray = { close: vi.fn() };
    releaseOverlay(stray, true);
    expect(openOverlayCount()).toBe(0);
    expect(stray.close).not.toHaveBeenCalled();
  });
});
