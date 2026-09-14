import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePendingAction } from "./use-pending-action";

describe("pending actions", () => {
  it("rejects repeated submissions and exposes success only after completion", async () => {
    const { result } = renderHook(usePendingAction);
    let finish!: () => void;
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let first!: Promise<boolean>;
    act(() => {
      first = result.current.run(action);
    });
    expect(result.current.pending).toBe(true);
    await act(async () => {
      expect(await result.current.run(action)).toBe(false);
    });
    expect(action).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      expect(await first).toBe(true);
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.failed).toBe(false);
  });
  it("retains failure state and allows an explicit retry", async () => {
    const { result } = renderHook(usePendingAction);
    await act(async () => {
      expect(
        await result.current.run(() => Promise.reject(new Error("offline"))),
      ).toBe(false);
    });
    expect(result.current.failed).toBe(true);
    await act(async () => {
      expect(await result.current.run(() => Promise.resolve())).toBe(true);
    });
    expect(result.current.failed).toBe(false);
  });
});
