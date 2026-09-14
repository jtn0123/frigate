import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenWakeLock } from "./screen-wake-lock";

const fallback = vi.hoisted(() => ({ enable: vi.fn(), disable: vi.fn() }));
vi.mock("nosleep.js", () => ({
  default: class {
    enable = fallback.enable;
    disable = fallback.disable;
  },
}));

function sentinel() {
  return { released: false, release: vi.fn().mockResolvedValue(undefined) };
}

describe("optional screen wake lock", () => {
  let wake: ScreenWakeLock;
  const request = vi.fn();

  beforeEach(() => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request },
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fallback.enable.mockResolvedValue(undefined);
    wake = new ScreenWakeLock();
  });
  afterEach(() => {
    wake.disable();
    Reflect.deleteProperty(navigator, "wakeLock");
    vi.restoreAllMocks();
  });

  it("handles denial without logging an error or starting the legacy fallback", async () => {
    request.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    wake.enable();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
    expect(error).not.toHaveBeenCalled();
    expect(fallback.enable).not.toHaveBeenCalled();
  });

  it("releases an acquired lock when fullscreen ends", async () => {
    const lock = sentinel();
    request.mockResolvedValue(lock);
    wake.enable();
    await Promise.resolve();
    wake.disable();
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("releases a request that completes after fullscreen has ended", async () => {
    const lock = sentinel();
    let finish!: (value: typeof lock) => void;
    request.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    wake.enable();
    wake.disable();
    finish(lock);
    await vi.waitFor(() => expect(lock.release).toHaveBeenCalledOnce());
  });

  it("does not duplicate pending or already held requests", async () => {
    const lock = sentinel();
    request.mockResolvedValue(lock);
    wake.enable();
    wake.enable();
    await Promise.resolve();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"])(
    "starts a fresh request after re-entry when the old request will %s",
    async (outcome) => {
      const oldLock = sentinel();
      const newLock = sentinel();
      let finish!: (value: typeof oldLock) => void;
      let fail!: (error: Error) => void;
      request
        .mockReturnValueOnce(
          new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
        )
        .mockResolvedValueOnce(newLock);
      wake.enable();
      wake.disable();
      wake.enable();
      expect(request).toHaveBeenCalledOnce();
      if (outcome === "resolve") finish(oldLock);
      else fail(new Error("Old request denied"));
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(oldLock.release).toHaveBeenCalledTimes(
        outcome === "resolve" ? 1 : 0,
      );
      expect(newLock.release).not.toHaveBeenCalled();
      wake.disable();
      expect(newLock.release).toHaveBeenCalledOnce();
    },
  );

  it("reacquires a browser-released lock when the page becomes visible", async () => {
    const lock = sentinel();
    const next = sentinel();
    request.mockResolvedValueOnce(lock).mockResolvedValueOnce(next);
    wake.enable();
    await Promise.resolve();
    lock.released = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    wake.disable();
    expect(next.release).toHaveBeenCalledOnce();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("waits for visibility and tolerates release failure", async () => {
    const lock = sentinel();
    lock.release.mockRejectedValue(new Error("Already revoked"));
    request.mockResolvedValue(lock);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    wake.enable();
    expect(request).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    wake.disable();
    await vi.waitFor(() => expect(lock.release).toHaveBeenCalledOnce());
  });

  it("preserves the fallback on browsers without the native API", async () => {
    Reflect.deleteProperty(navigator, "wakeLock");
    wake.enable();
    await Promise.resolve();
    expect(fallback.enable).toHaveBeenCalledOnce();
    wake.disable();
    expect(fallback.disable).toHaveBeenCalledOnce();
  });

  it("handles a denied legacy video request", async () => {
    Reflect.deleteProperty(navigator, "wakeLock");
    fallback.enable.mockRejectedValue(new Error("Autoplay denied"));
    wake.enable();
    await vi.waitFor(() => expect(fallback.enable).toHaveBeenCalledOnce());
  });

  it("stops the legacy fallback if its pending request completes after exit", async () => {
    Reflect.deleteProperty(navigator, "wakeLock");
    let finish!: () => void;
    fallback.enable.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    wake.enable();
    wake.disable();
    expect(fallback.disable).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() => expect(fallback.disable).toHaveBeenCalledTimes(2));
  });

  it("stops the old legacy request before restarting it for a new session", async () => {
    Reflect.deleteProperty(navigator, "wakeLock");
    let finish!: () => void;
    fallback.enable.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    wake.enable();
    wake.disable();
    wake.enable();
    finish();
    await vi.waitFor(() => expect(fallback.enable).toHaveBeenCalledTimes(2));
    expect(fallback.disable).toHaveBeenCalledTimes(2);
    expect(fallback.disable.mock.invocationCallOrder[1]).toBeLessThan(
      fallback.enable.mock.invocationCallOrder[1],
    );
  });
});
