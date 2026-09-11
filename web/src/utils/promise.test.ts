import { describe, expect, it, vi } from "vitest";
import { wrapAsync } from "./promise";

describe("wrapAsync", () => {
  it("invokes the function and returns void, not a promise", () => {
    const fn = vi.fn(async (n: number) => n + 1);
    const wrapped = wrapAsync(fn);
    expect(wrapped(1)).toBeUndefined();
    expect(fn).toHaveBeenCalledWith(1);
  });

  it("does not throw when the async function rejects (callee handles it)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("handled inside");
    });
    const wrapped = wrapAsync(async () => {
      try {
        await fn();
      } catch {
        /* toast path */
      }
    });
    expect(() => wrapped()).not.toThrow();
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
  });
});
