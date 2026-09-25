import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useUnsureFirst } from "./use-train-order";

const stored: Record<string, unknown> = {};
vi.mock("idb-keyval", () => ({
  get: (key: string) => Promise.resolve(stored[key]),
  set: (key: string, value: unknown) => {
    stored[key] = value;
    return Promise.resolve();
  },
  del: (key: string) => {
    delete stored[key];
    return Promise.resolve();
  },
}));

describe("useUnsureFirst", () => {
  it("defaults to newest first and remembers the switch", async () => {
    const { result } = renderHook(() => useUnsureFirst());
    expect(result.current[0]).toBe(false);
    await waitFor(() => expect(result.current[2]).toBe(true));
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    await waitFor(() => expect(stored["fork.trainUnsureFirst"]).toBe(true));
  });

  it("holds the order until the stored choice is read", async () => {
    stored["fork.trainUnsureFirst"] = true;
    const { result } = renderHook(() => useUnsureFirst());
    expect(result.current[2]).toBe(false);
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe(true);
  });
});
