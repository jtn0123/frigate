/** Sort strings by UTF-16 code units without mutating cached or caller data. */
export function sortedStrings<T extends string>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}
