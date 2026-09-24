/**
 * Fork (D54): which timestamp format a metric graph's time axis uses.
 *
 * The live window is 20 minutes, so a time of day is enough. A stored range
 * can reach back a month, where "9:00 AM" repeats on every day, so a graph
 * whose samples span more than two days labels its ticks with the date. The
 * date alone, since a date and a time are too wide for the axis to fit.
 */

const DATED_SPAN = 2 * 24 * 60 * 60;

/** The `common` namespace key to format a graph's ticks with. */
export function metricTimeFormatKey(
  updateTimes: readonly number[],
  timeFormat: string,
): string {
  const first = updateTimes[0];
  const last = updateTimes[updateTimes.length - 1];

  return first !== undefined && last !== undefined && last - first > DATED_SPAN
    ? "time.formattedTimestampMonthDay"
    : `time.formattedTimestampHourMinute.${timeFormat}`;
}
