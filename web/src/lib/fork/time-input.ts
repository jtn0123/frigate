/** Preserve the selected local date only when a complete clock is valid. */
export function parseTimeInput(
  clock: string,
  timestamp: number,
  isIOS: boolean,
): number | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(clock);
  if (!match || !Number.isFinite(timestamp)) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(timestamp * 1000);
  date.setHours(hour, minute, isIOS ? 0 : second, 0);
  const result = date.getTime() / 1000;
  return Number.isFinite(result) ? result : null;
}
