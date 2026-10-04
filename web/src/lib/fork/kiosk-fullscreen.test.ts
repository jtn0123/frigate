import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enterPageFullscreen,
  exitPageFullscreen,
  isPageFullscreen,
  supportsPageFullscreen,
  togglePageFullscreen,
} from "./kiosk-fullscreen";

const DOCUMENT_KEYS = [
  "fullscreenElement",
  "fullscreenEnabled",
  "exitFullscreen",
  "webkitFullscreenElement",
  "webkitFullscreenEnabled",
  "webkitExitFullscreen",
] as const;
const ROOT_KEYS = ["requestFullscreen", "webkitRequestFullscreen"] as const;

function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { configurable: true, value });
}

afterEach(() => {
  for (const key of DOCUMENT_KEYS) {
    Reflect.deleteProperty(document, key);
  }
  for (const key of ROOT_KEYS) {
    Reflect.deleteProperty(document.documentElement, key);
  }
});

describe("page fullscreen", () => {
  it("reports the standard and the prefixed state", () => {
    expect(isPageFullscreen()).toBe(false);
    expect(supportsPageFullscreen()).toBe(false);
    define(document, "webkitFullscreenElement", document.documentElement);
    define(document, "webkitFullscreenEnabled", true);
    expect(isPageFullscreen()).toBe(true);
    expect(supportsPageFullscreen()).toBe(true);
    // the standard API wins when the browser has it
    define(document, "webkitFullscreenElement", null);
    define(document, "fullscreenElement", document.body);
    define(document, "fullscreenEnabled", false);
    expect(isPageFullscreen()).toBe(true);
    expect(supportsPageFullscreen()).toBe(false);
  });

  it("requests fullscreen on the whole page and ignores a refusal", async () => {
    const request = vi.fn().mockRejectedValue(new Error("no gesture"));
    define(document.documentElement, "requestFullscreen", request);
    await expect(enterPageFullscreen()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("falls back to the prefixed request", async () => {
    const request = vi.fn();
    define(document.documentElement, "webkitRequestFullscreen", request);
    await togglePageFullscreen();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does nothing when already in the state asked for", async () => {
    const request = vi.fn();
    const exit = vi.fn();
    define(document.documentElement, "requestFullscreen", request);
    define(document, "exitFullscreen", exit);
    await exitPageFullscreen();
    expect(exit).not.toHaveBeenCalled();
    define(document, "fullscreenElement", document.documentElement);
    await enterPageFullscreen();
    expect(request).not.toHaveBeenCalled();
  });

  it("leaves fullscreen with the standard or the prefixed call", async () => {
    define(document, "fullscreenElement", document.documentElement);
    const exit = vi.fn().mockRejectedValue(new Error("already left"));
    define(document, "exitFullscreen", exit);
    await togglePageFullscreen();
    expect(exit).toHaveBeenCalledTimes(1);

    Reflect.deleteProperty(document, "exitFullscreen");
    const webkitExit = vi.fn();
    define(document, "webkitExitFullscreen", webkitExit);
    await exitPageFullscreen();
    expect(webkitExit).toHaveBeenCalledTimes(1);
  });
});
