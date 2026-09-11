import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { useBulkSelection } from "./use-bulk-selection";

type Item = { id: string };
const items: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

function useHarness() {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  return useBulkSelection({
    items,
    getId: (item) => item.id,
    selectedIds,
    setSelectedIds,
  });
}

function press(key: string, type: "keydown" | "keyup") {
  window.dispatchEvent(
    new KeyboardEvent(type, {
      key,
      shiftKey: key === "Shift" && type === "keydown",
      ctrlKey: key === "Control" && type === "keydown",
    }),
  );
}

describe("useBulkSelection", () => {
  it("leaves plain clicks to the view until selection mode is on", () => {
    const { result } = renderHook(useHarness);
    let handled = true;
    act(() => {
      handled = result.current.onItemClick(items[0], false);
    });
    expect(handled).toBe(false);
    expect(result.current.selectedIds).toEqual([]);

    act(() => result.current.setActive(true));
    act(() => {
      handled = result.current.onItemClick(items[0], false);
    });
    expect(handled).toBe(true);
    expect(result.current.selectedIds).toEqual(["a"]);

    act(() => {
      result.current.onItemClick(items[0], false);
    });
    expect(result.current.selectedIds).toEqual([]);
  });

  it("selects a range with Shift from the last clicked item", () => {
    const { result } = renderHook(useHarness);
    act(() => result.current.setActive(true));
    act(() => {
      result.current.onItemClick(items[1], false);
    });
    act(() => press("Shift", "keydown"));
    act(() => {
      result.current.onItemClick(items[3], false);
    });
    act(() => press("Shift", "keyup"));
    expect(result.current.selectedIds).toEqual(["b", "c", "d"]);
    expect(result.current.selectedItems.map((i) => i.id)).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("selects all, clears and exits the mode on Escape", () => {
    const { result } = renderHook(useHarness);
    act(() => result.current.setActive(true));
    act(() => result.current.selectAll());
    expect(result.current.selectedIds).toEqual(["a", "b", "c", "d"]);
    act(() => result.current.clear());
    expect(result.current.selectedIds).toEqual([]);
    act(() => press("Escape", "keydown"));
    expect(result.current.active).toBe(false);
  });
});
