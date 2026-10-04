/**
 * Fork (UI143): runs the synced grid's master clock inside React.
 *
 * The clock and its sync loop live in `SyncedPlaybackEngine`; this hook
 * owns one engine per grid, keeps its options current, ticks it, and
 * re-renders on the state the grid draws (play state, tile gaps, the
 * playlist anchor). `useSyncedPlaybackRate` holds the grid's speed.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useOverlayState } from "@/hooks/use-overlay-state";
import { useUserPersistence } from "@/hooks/use-user-persistence";
import {
  SyncedPlaybackEngine,
  type SyncedPlaybackCallbacks,
  type SyncedPlaybackEngineOptions,
} from "@/lib/fork/synced-playback-engine";
import { clampSyncedRate, SYNC_TICK_MS } from "@/lib/fork/synced-playback";

export type SyncedPlaybackOptions = SyncedPlaybackEngineOptions &
  SyncedPlaybackCallbacks & {
    /** The view's playback start; read when the chunk changes. */
    startTimestamp: number;
  };

export function useSyncedPlayback(options: SyncedPlaybackOptions) {
  const {
    startTimestamp,
    onTimestampUpdate,
    onSeekToTime,
    onClipEnded,
    ...engineOptions
  } = options;

  const [engine] = useState(
    () =>
      new SyncedPlaybackEngine(startTimestamp, engineOptions, {
        onTimestampUpdate,
        onSeekToTime,
        onClipEnded,
      }),
  );

  // declared first so the effects below see this render's options
  useEffect(() => {
    engine.options = engineOptions;
    engine.callbacks = { onTimestampUpdate, onSeekToTime, onClipEnded };
  });

  useEffect(() => engine.start(SYNC_TICK_MS), [engine]);

  const { after, before } = options.timeRange;
  const chunkRef = useRef({ after, before });

  useEffect(() => {
    const chunk = chunkRef.current;

    if (chunk.after != after || chunk.before != before) {
      chunkRef.current = { after, before };
      engine.chunkChanged(startTimestamp);
    }
    // only a chunk change moves the anchor; startTimestamp is read then
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [after, before]);

  const { rate, muted, mainCamera } = options;

  // before paint, so a tile that loses the main role never plays audio
  useLayoutEffect(() => {
    engine.options = { ...engine.options, muted, mainCamera };
    engine.applyMutes();
  }, [engine, muted, mainCamera]);

  useEffect(() => {
    engine.setRate(rate);
  }, [engine, rate]);

  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  return { engine, snapshot };
}

/**
 * The grid's speed and its setter. The choice is the single player's
 * (`playbackRate` overlay state, then the user's default), which offers
 * 16x; the grid plays and shows the nearest speed it has, so its menu and
 * its tiles agree. The single player keeps its own choice for when the
 * grid is turned off.
 */
export function useSyncedPlaybackRate(): [number, (rate: number) => void] {
  const [defaultRate] = useUserPersistence("playbackRate", 1);
  const [rate, setRate] = useOverlayState<number>(
    "playbackRate",
    defaultRate ?? 1,
  );
  const setGridRate = useCallback(
    (next: number) => setRate(next, true),
    [setRate],
  );

  return [clampSyncedRate(rate ?? 1), setGridRate];
}
