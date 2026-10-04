import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useRowKeys } from "./use-row-keys";

describe("useRowKeys", () => {
  it("gives each row its own key and keeps it while the count holds", () => {
    const { result, rerender } = renderHook(({ count }) => useRowKeys(count), {
      initialProps: { count: 3 },
    });
    const first = result.current.keys;
    expect(new Set(first).size).toBe(3);

    rerender({ count: 3 });
    expect(result.current.keys).toEqual(first);
  });

  it("keeps the other rows' keys when a row is removed", () => {
    const { result, rerender } = renderHook(({ count }) => useRowKeys(count), {
      initialProps: { count: 3 },
    });
    const [a, , c] = result.current.keys;

    act(() => result.current.remove(1));
    rerender({ count: 2 });
    expect(result.current.keys).toEqual([a, c]);
  });

  it("adds new keys at the end and drops keys from the end", () => {
    const { result, rerender } = renderHook(({ count }) => useRowKeys(count), {
      initialProps: { count: 2 },
    });
    const [a, b] = result.current.keys;

    rerender({ count: 3 });
    const added = result.current.keys[2];
    expect(result.current.keys.slice(0, 2)).toEqual([a, b]);
    expect([a, b]).not.toContain(added);

    // A reset that empties the list, then a new row, never reuses a key
    rerender({ count: 0 });
    expect(result.current.keys).toEqual([]);
    rerender({ count: 1 });
    expect([a, b, added]).not.toContain(result.current.keys[0]);
  });
});
