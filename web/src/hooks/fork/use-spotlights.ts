/**
 * Data for the Spotlights page (fork, UI144).
 *
 * One `/review` read for the window, plus, when license plate recognition is
 * on, one `/events` read for the objects in it that have a recognized plate
 * (review items do not carry plates). Both go through SWR, and the ranking is
 * the pure `rankSpotlights`.
 *
 * While the page is open it stays fresh without reading the window again:
 * the `reviews` websocket topic, and a slow poll behind it, trigger a small
 * read of what ended since the last one (`spotlights-live.ts`). New items
 * wait behind `fresh` until the page shows them, so cards do not move.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { apiGet, useApi } from "@/api/fork/client";
import { useFrigateReviews } from "@/api/ws";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { ReviewSegment } from "@/types/review";
import type { TimeRange } from "@/types/timeline";
import type { FrigateReview } from "@/types/ws";
import {
  RANGE_SECONDS,
  knownPlateNames,
  loiteringZoneMap,
  platesByEvent,
  rankSpotlights,
  withReviewState,
  type SpotlightContext,
  type SpotlightItem,
  type SpotlightRange,
} from "@/lib/fork/spotlights";
import {
  REFRESH_OVERLAP_SECONDS,
  REFRESH_POLL_MS,
  addReviews,
  mergeReviews,
  pinFeed,
  readPinned,
  refreshDelay,
  type PinnedFeed,
} from "@/lib/fork/spotlights-live";

/** Most recognized plates looked up for one window. */
export const PLATE_LOOKUP_LIMIT = 500;

/**
 * `/events` treats a plate filter with regex characters as a pattern, so this
 * matches every object that has a recognized plate and skips the rest.
 */
const ANY_PLATE = ".+";

type LprWithPlates = FrigateConfig["lpr"] & {
  known_plates?: Record<string, unknown> | null;
};

function lprEnabled(config: FrigateConfig): boolean {
  return (
    config.lpr.enabled ||
    Object.values(config.cameras).some((camera) => camera.lpr.enabled)
  );
}

function faceRecognitionEnabled(config: FrigateConfig): boolean {
  return (
    config.face_recognition.enabled ||
    Object.values(config.cameras).some(
      (camera) => camera.face_recognition.enabled,
    )
  );
}

export function spotlightContext(
  config: FrigateConfig | undefined,
  plates: ReadonlyMap<string, string>,
): SpotlightContext {
  if (!config) {
    return {
      knownPlateNames: new Set(),
      faceRecognition: false,
      plates,
      loiteringZones: {},
    };
  }
  return {
    knownPlateNames: knownPlateNames(
      (config.lpr as LprWithPlates).known_plates,
    ),
    faceRecognition: faceRecognitionEnabled(config),
    plates,
    loiteringZones: loiteringZoneMap(config.cameras),
  };
}

type UseSpotlightsOptions = {
  range: SpotlightRange;
  /** Only these cameras, or all of them. */
  cameras: string[] | undefined;
};

export type SpotlightsData = {
  config: FrigateConfig | undefined;
  /** Undefined while loading. In the order they were last shown. */
  items: SpotlightItem[] | undefined;
  /** Items that arrived since, waiting for `showFresh`. */
  fresh: number;
  /** Their review ids, best first. */
  freshIds: readonly string[];
  /** Re-ranks with everything that arrived. */
  showFresh: () => void;
  /** Items in the window left out for having no strong signal. */
  hidden: number;
  timeRange: TimeRange;
  error: unknown;
  retry: () => void;
  /** Marks items reviewed (or back to unreviewed) and keeps their place. */
  setReviewed: (
    reviews: readonly ReviewSegment[],
    reviewed: boolean,
  ) => Promise<void>;
};

function minute(seconds: number): number {
  return Math.floor(seconds / 60) * 60;
}

type LiveState = {
  /** The query these belong to; a new range or camera set starts over. */
  key: string;
  reviews: ReadonlyMap<string, ReviewSegment>;
  plates: ReadonlyMap<string, string>;
  /** Unix seconds when the newest read was sent. */
  syncedAt: number;
};

type LiveOptions = {
  key: string;
  /** When the first read of the window was sent. */
  since: number;
  cameraParam: string;
  cameras: string[] | undefined;
  /** The first read has landed, so there is something to add to. */
  ready: boolean;
  wantPlates: boolean;
};

/**
 * What changed since the first read: each refresh asks `/review` (and the
 * plate lookup) only from the last refresh on.
 */
function useLiveReviews({
  key,
  since,
  cameraParam,
  cameras,
  ready,
  wantPlates,
}: LiveOptions): LiveState {
  const [state, setState] = useState<LiveState>({
    key,
    reviews: new Map(),
    plates: new Map(),
    syncedAt: since,
  });
  const live: LiveState =
    state.key === key
      ? state
      : { key, reviews: new Map(), plates: new Map(), syncedAt: since };

  // the timers read the newest values without being torn down each render
  const current = useRef({ key, cameraParam, ready, wantPlates, live });
  current.current = { key, cameraParam, ready, wantPlates, live };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastRun = useRef<number | undefined>(undefined);
  const inFlight = useRef(false);
  // a GenAI description can land long after its item ended, past where the
  // next refresh would start, so a message reaches back to its item
  const reachBack = useRef<number | undefined>(undefined);
  const reachBackTo = useCallback((seconds: number) => {
    reachBack.current = Math.min(reachBack.current ?? Infinity, seconds);
  }, []);

  const refresh = useCallback(async () => {
    const options = current.current;
    if (!options.ready || document.visibilityState === "hidden") {
      return;
    }
    inFlight.current = true;
    lastRun.current = Date.now();
    const sentAt = Math.floor(Date.now() / 1000);
    const reach = reachBack.current;
    reachBack.current = undefined;
    const after = Math.min(
      options.live.syncedAt - REFRESH_OVERLAP_SECONDS,
      reach ?? Infinity,
    );
    const params = { after, cameras: options.cameraParam };
    try {
      const [reviews, events] = await Promise.all([
        apiGet("/review", params),
        options.wantPlates
          ? apiGet("/events", {
              ...params,
              recognized_license_plate: ANY_PLATE,
              limit: PLATE_LOOKUP_LIMIT,
            }).catch(() => undefined)
          : undefined,
      ]);
      setState((previous) => {
        // the range or cameras changed while this was out
        if (current.current.key !== options.key) {
          return previous;
        }
        const base = previous.key === options.key ? previous : options.live;
        return {
          key: options.key,
          reviews: addReviews(base.reviews, reviews),
          plates: new Map([...base.plates, ...platesByEvent(events)]),
          syncedAt: Math.max(base.syncedAt, sentAt),
        };
      });
    } catch {
      // the next message or poll tries again from the same point
      if (reach !== undefined) {
        reachBackTo(reach);
      }
    } finally {
      inFlight.current = false;
    }
  }, [reachBackTo]);

  const schedule = useCallback(() => {
    if (timer.current !== undefined) {
      return;
    }
    timer.current = setTimeout(
      () => {
        timer.current = undefined;
        if (inFlight.current) {
          schedule();
        } else {
          void refresh();
        }
      },
      refreshDelay(Date.now(), lastRun.current),
    );
  }, [refresh]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    },
    [key],
  );

  // the same signal the Review page updates its items from
  // (undefined until the first message, whatever its type says)
  const update = useFrigateReviews() as FrigateReview | undefined;
  useEffect(() => {
    if (!update) {
      return;
    }
    const changed = update.after;
    if (cameras?.length && !cameras.includes(changed.camera)) {
      return;
    }
    if (changed.end_time) {
      reachBackTo(Math.floor(changed.end_time) - 1);
    }
    schedule();
  }, [update, cameras, schedule, reachBackTo]);

  useEffect(() => {
    const poll = setInterval(schedule, REFRESH_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        schedule();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [schedule]);

  return live;
}

type Pin = { key: string; feed: PinnedFeed; timeRange: TimeRange };

const NO_IDS: readonly string[] = [];

export function useSpotlights({
  range,
  cameras,
}: UseSpotlightsOptions): SpotlightsData {
  const { data: config } = useApi("/config", {
    revalidateOnFocus: false,
  });

  const cameraParam = cameras?.length ? cameras.join(",") : "all";
  const key = `${range}|${cameraParam}`;

  // fixed for as long as the range and cameras are, so the SWR key is
  // stable; `before` is left to the server, which reads it as now. Later
  // reads only ask for what changed (`useLiveReviews`).
  const firstRead = useMemo<TimeRange>(() => {
    const now = minute(Date.now() / 1000);
    return { after: now - RANGE_SECONDS[range], before: now };
    // a new camera set is a new first read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, cameraParam]);

  const reviews = useApi("/review", {
    params: { after: firstRead.after, cameras: cameraParam },
    // a refocus or reconnect refreshes through `useLiveReviews`, not the
    // whole window
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  const wantPlates = config ? lprEnabled(config) : false;
  const plateEvents = useApi(wantPlates ? "/events" : null, {
    params: {
      after: firstRead.after,
      cameras: cameraParam,
      recognized_license_plate: ANY_PLATE,
      limit: PLATE_LOOKUP_LIMIT,
    },
    revalidateOnFocus: false,
  });

  const live = useLiveReviews({
    key,
    since: firstRead.before,
    cameraParam,
    cameras,
    ready: reviews.data !== undefined,
    wantPlates,
  });

  const context = useMemo(
    () =>
      spotlightContext(
        config,
        new Map([...platesByEvent(plateEvents.data), ...live.plates]),
      ),
    [config, plateEvents.data, live.plates],
  );

  // a failed plate lookup only costs the plate chips, so it does not hold
  // the feed back
  const platesSettled =
    !wantPlates ||
    plateEvents.data !== undefined ||
    plateEvents.error !== undefined;

  const [reviewStates, setReviewStates] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());

  // the window slides with each refresh, so a page left open overnight
  // still shows the last 24 hours
  const windowStart = minute(live.syncedAt) - RANGE_SECONDS[range];
  const latest = useMemo(() => {
    if (!reviews.data || !config || !platesSettled) {
      return undefined;
    }
    const merged = mergeReviews(reviews.data, live.reviews);
    return rankSpotlights(withReviewState(merged, reviewStates), context, {
      after: windowStart,
      cameras,
    });
  }, [
    reviews.data,
    live.reviews,
    config,
    platesSettled,
    reviewStates,
    context,
    windowStart,
    cameras,
  ]);

  const [pin, setPin] = useState<Pin>();
  const kept = pin?.key === key ? pin : undefined;
  const syncedAt = live.syncedAt;
  const pinLatest = useCallback(
    (items: readonly SpotlightItem[]): Pin => ({
      key,
      feed: pinFeed(items),
      timeRange: { after: windowStart, before: minute(syncedAt) },
    }),
    [key, windowStart, syncedAt],
  );
  // the first ranking shows as it is, and so does anything arriving on an
  // empty feed: there is nothing on screen to move
  const autoPin =
    latest !== undefined &&
    (kept === undefined ||
      (kept.feed.ids.length === 0 && latest.items.length > 0));
  const autoPinned = useMemo(
    () => (autoPin ? pinLatest(latest.items) : undefined),
    [autoPin, latest, pinLatest],
  );
  useEffect(() => {
    if (autoPinned) {
      setPin(autoPinned);
    }
  }, [autoPinned]);
  const shown = autoPinned ?? kept;

  const view = useMemo(
    () => (shown && latest ? readPinned(shown.feed, latest.items) : undefined),
    [shown, latest],
  );

  const showFresh = useCallback(() => {
    if (latest) {
      setPin(pinLatest(latest.items));
    }
  }, [latest, pinLatest]);

  const setReviewed = useCallback(
    async (targets: readonly ReviewSegment[], reviewed: boolean) => {
      await axios.post("reviews/viewed", {
        ids: targets.map((review) => review.id),
        reviewed,
      });
      setReviewStates((current) => {
        const next = new Map(current);
        for (const review of targets) {
          next.set(review.id, reviewed);
        }
        return next;
      });
    },
    [],
  );

  const { mutate: mutateReviews } = reviews;
  const retry = useCallback(() => {
    void mutateReviews();
  }, [mutateReviews]);

  return {
    config,
    items: view?.items,
    fresh: view?.fresh ?? 0,
    freshIds: view?.freshIds ?? NO_IDS,
    showFresh,
    hidden: latest?.hidden ?? 0,
    timeRange: shown?.timeRange ?? firstRead,
    error: reviews.error,
    retry,
    setReviewed,
  };
}
