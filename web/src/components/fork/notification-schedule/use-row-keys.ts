/** Fork (D78): React keys for list rows that have no ids of their own. */

import { useCallback, useState } from "react";

type RowKeys = {
  keys: number[];
  /** The key the next new row gets. */
  next: number;
};

/** Drop keys from the end, or give new rows at the end new keys. */
function fitKeys(rows: RowKeys, count: number): RowKeys {
  if (rows.keys.length === count) {
    return rows;
  }
  const keys = rows.keys.slice(0, count);
  let next = rows.next;
  while (keys.length < count) {
    keys.push(next);
    next += 1;
  }
  return { keys, next };
}

/**
 * Keys that stay with each row as rows are edited, added and removed, so
 * React does not hand one row's DOM (and focus) to another.
 *
 * Args:
 *     count: How many rows the list has now. Rows added or dropped outside
 *         `remove` (a new row, a form reset) are taken to be at the end.
 *
 * Returns:
 *     A key per row, and `remove` to call along with removing a row.
 */
export function useRowKeys(count: number) {
  const [rows, setRows] = useState(() => fitKeys({ keys: [], next: 0 }, count));
  const fitted = fitKeys(rows, count);
  if (fitted !== rows) {
    setRows(fitted);
  }
  const remove = useCallback(
    (index: number) =>
      setRows((current) => ({
        ...current,
        keys: current.keys.filter((_, i) => i !== index),
      })),
    [],
  );
  return { keys: fitted.keys, remove };
}
