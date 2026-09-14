import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openOverlayCount,
  pushOverlay,
  releaseOverlay,
  resetOverlayHistory,
} from "./overlay-history";

// jsdom delivers popstate for history.back() asynchronously
async function flushHistory() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function pressBack() {
  window.history.back();
  await flushHistory();
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
    releaseOverlay(dialog, true);
    await flushHistory();
    expect(drawer.close).not.toHaveBeenCalled();
    expect(openOverlayCount()).toBe(1);

    await pressBack();
    expect(drawer.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the history entry when the URL moved on", async () => {
    const back = vi.spyOn(window.history, "back");
    const drawer = { close: vi.fn() };
    pushOverlay(drawer);
    releaseOverlay(drawer, false);
    await flushHistory();
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

  it("does not go back when a view navigated while it was open", async () => {
    const back = vi.spyOn(window.history, "back");
    const drawer = { close: vi.fn() };
    pushOverlay(drawer);
    // A state-only navigation (same URL), like choosing a timeline mode
    window.history.pushState({ usr: { timelineType: "detail" } }, "");
    releaseOverlay(drawer, true);
    await flushHistory();
    expect(back).not.toHaveBeenCalled();
    expect(openOverlayCount()).toBe(0);
    back.mockRestore();
  });

  it("ignores a release for an overlay it does not hold", async () => {
    const stray = { close: vi.fn() };
    releaseOverlay(stray, true);
    await flushHistory();
    expect(openOverlayCount()).toBe(0);
    expect(stray.close).not.toHaveBeenCalled();
  });
});
