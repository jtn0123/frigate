/**
 * Fork: selection mode for grids that already support multi-select.
 *
 * Wraps a view's existing `selectedIds` state with a "Select" mode (every
 * click toggles instead of opening), Shift-click range selection and
 * Ctrl-click on platforms where upstream only honours the Meta key. The
 * view calls `onItemClick` first and falls through to its own handler when
 * it returns false, so upstream behaviour is untouched when the flag is off.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isForkEnabled } from "@/fork/flags";

export type UseBulkSelectionOptions<T> = {
  items: T[] | null | undefined;
  getId: (item: T) => string;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
};

export type BulkSelection<T> = {
  enabled: boolean;
  active: boolean;
  setActive: (active: boolean) => void;
  items: T[];
  selectedIds: string[];
  selectedItems: T[];
  setSelectedIds: (ids: string[]) => void;
  selectAll: () => void;
  clear: () => void;
  /** Returns true when the click was consumed (mode, range or ctrl select). */
  onItemClick: (item: T, ctrl: boolean) => boolean;
};

export function useBulkSelection<T>({
  items,
  getId,
  selectedIds,
  setSelectedIds,
}: UseBulkSelectionOptions<T>): BulkSelection<T> {
  const enabled = isForkEnabled("bulkActions");
  const [active, setActive] = useState(false);
  const anchorRef = useRef<string | null>(null);
  const shiftRef = useRef(false);
  const ctrlRef = useRef(false);
  const list = useMemo(() => items ?? [], [items]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      shiftRef.current = event.shiftKey;
      ctrlRef.current = event.ctrlKey;
      if (event.type === "keydown" && event.key === "Escape") {
        setActive(false);
      }
    };
    const onBlur = () => {
      shiftRef.current = false;
      ctrlRef.current = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [enabled]);

  const selectAll = useCallback(() => {
    setSelectedIds(list.map(getId));
  }, [list, getId, setSelectedIds]);

  const clear = useCallback(() => {
    setSelectedIds([]);
    anchorRef.current = null;
  }, [setSelectedIds]);

  const onItemClick = useCallback(
    (item: T, ctrl: boolean) => {
      if (!enabled) return false;
      const id = getId(item);
      const ids = list.map(getId);

      if (
        shiftRef.current &&
        anchorRef.current &&
        ids.includes(anchorRef.current)
      ) {
        const from = ids.indexOf(anchorRef.current);
        const to = ids.indexOf(id);
        const [start, end] = from < to ? [from, to] : [to, from];
        const next = new Set(selectedIds);
        ids.slice(start, end + 1).forEach((rangeId) => next.add(rangeId));
        setSelectedIds(ids.filter((candidate) => next.has(candidate)));
        return true;
      }

      if (active || ctrlRef.current) {
        const next = new Set(selectedIds);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        anchorRef.current = id;
        setSelectedIds(ids.filter((candidate) => next.has(candidate)));
        return true;
      }

      if (ctrl || selectedIds.length > 0) {
        anchorRef.current = id;
      }
      return false;
    },
    [enabled, active, list, getId, selectedIds, setSelectedIds],
  );

  const selectedItems = useMemo(() => {
    const set = new Set(selectedIds);
    return list.filter((item) => set.has(getId(item)));
  }, [list, selectedIds, getId]);

  return useMemo(
    () => ({
      enabled,
      active,
      setActive,
      items: list,
      selectedIds,
      selectedItems,
      setSelectedIds,
      selectAll,
      clear,
      onItemClick,
    }),
    [
      enabled,
      active,
      list,
      selectedIds,
      selectedItems,
      setSelectedIds,
      selectAll,
      clear,
      onItemClick,
    ],
  );
}
