import NoSleep from "nosleep.js";

/** Optional screen-awake support, scoped to one fullscreen player. */
export class ScreenWakeLock {
  private enabled = false;
  private pending = false;
  private lock: WakeLockSentinel | undefined;
  private fallback: NoSleep | undefined;

  enable() {
    this.enabled = true;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    void this.acquire();
  }

  disable() {
    this.enabled = false;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    const lock = this.lock;
    this.lock = undefined;
    if (lock) void this.release(lock);
    this.fallback?.disable();
  }

  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "visible") void this.acquire();
  };

  private async release(lock: WakeLockSentinel) {
    try {
      await lock.release();
    } catch {
      // The browser may already have revoked this optional lock.
    }
  }

  private canAcquire(): boolean {
    return (
      this.enabled &&
      !this.pending &&
      (!this.lock || this.lock.released) &&
      document.visibilityState === "visible"
    );
  }

  private async acquire() {
    if (!this.canAcquire()) return;
    this.pending = true;
    try {
      if ("wakeLock" in navigator) {
        const lock = await navigator.wakeLock.request("screen");
        if (this.enabled) this.lock = lock;
        else await this.release(lock);
      } else {
        // Keep the legacy video fallback, but avoid NoSleep's native API
        // path, which logs and rethrows ordinary permission denials.
        this.fallback ??= new NoSleep();
        await this.fallback.enable();
        if (!this.enabled) this.fallback.disable();
      }
    } catch {
      // Permission, battery policy, and visibility can deny screen-awake
      // requests. Fullscreen playback must remain usable in all three cases.
    } finally {
      this.pending = false;
    }
  }
}
