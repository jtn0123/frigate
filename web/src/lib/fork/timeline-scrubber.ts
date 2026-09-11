/**
 * Snap and step maths for the fork timeline scrubber (UI8).
 *
 * Review items sometimes arrive as unix seconds and sometimes as ISO
 * strings (e2e mocks). Normalize first so snap/step stay numeric.
 */

export function toUnixTime(
  value: number | string | undefined | null,
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return asNumber;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return parsed / 1000;
  }
  return undefined;
}

export function eventTimesFromItems(
  items: ReadonlyArray<{ start_time?: number | string | null }>,
): number[] {
  const times = new Set<number>();
  for (const item of items) {
    const time = toUnixTime(item.start_time);
    if (time != undefined) {
      times.add(time);
    }
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Snap `time` to the nearest event. When `maxDistance` is set and the
 * nearest event is farther than that, `time` is left unchanged.
 */
export function snapToNearestEvent(
  time: number,
  eventTimes: readonly number[],
  maxDistance?: number,
): number {
  if (!Number.isFinite(time) || eventTimes.length === 0) {
    return time;
  }

  const first = eventTimes.at(0);
  if (first === undefined) {
    return time;
  }

  let nearest = first;
  let best = Math.abs(time - nearest);
  for (const eventTime of eventTimes) {
    const delta = Math.abs(time - eventTime);
    if (delta < best) {
      nearest = eventTime;
      best = delta;
    }
  }

  if (maxDistance != undefined && best > maxDistance) {
    return time;
  }
  return nearest;
}

/**
 * Step from `time` to the next (direction 1) or previous (direction -1)
 * event. Stays on the first/last event when there is nowhere further to go.
 */
export function stepToEvent(
  time: number,
  eventTimes: readonly number[],
  direction: -1 | 1,
): number {
  if (eventTimes.length === 0) {
    return time;
  }

  const sorted = [...eventTimes].sort((a, b) => a - b);
  const last = sorted.at(-1);
  const first = sorted.at(0);
  if (first === undefined || last === undefined) {
    return time;
  }

  if (direction === 1) {
    const next = sorted.find((eventTime) => eventTime > time);
    return next ?? last;
  }

  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const candidate = sorted.at(index);
    if (candidate !== undefined && candidate < time) {
      return candidate;
    }
  }
  return first;
}
