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

/** Timeline segments (8 px each) a release may be from an event and snap. */
export const SNAP_SEGMENTS = 4;

/**
 * Farthest, in seconds, a handlebar release snaps to an event (UI73): a few
 * segments, so the reach is the same on screen at every zoom level.
 */
export function snapMaxDistance(segmentDuration: number): number {
  return segmentDuration * SNAP_SEGMENTS;
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

/**
 * Space, in pixels, kept between a followed segment and the rail's edges
 * (UI106). The current-time pill is 32 px tall and centered on its segment,
 * and the rail fades its last 30 px, so a segment on the very last row left
 * half of the pill cut off.
 */
export const FOLLOW_EDGE_MARGIN = 40;

/**
 * Whether a segment sits far enough inside the scrolled viewport that the
 * pill drawn on it is fully visible. A rail too short for the margin on both
 * sides falls back to plain visibility.
 */
export function isSegmentWellInView(
  segmentTop: number,
  segmentHeight: number,
  scrollTop: number,
  viewportHeight: number,
  margin: number = FOLLOW_EDGE_MARGIN,
): boolean {
  const edge = Math.min(
    margin,
    Math.max(0, (viewportHeight - segmentHeight) / 2),
  );
  return (
    segmentTop >= scrollTop + edge &&
    segmentTop + segmentHeight <= scrollTop + viewportHeight - edge
  );
}
