import { useCallback, useEffect, useState } from "react";
import { LivePlayerError } from "@/types/live";

export const LIVE_STARTUP_TIMEOUT_MS = 10_000;

/** Track actual playback separately from successful socket/codec negotiation. */
export function useLivePlaybackStatus(identity: string, enabled: boolean) {
  const [failure, setFailure] = useState<LivePlayerError>();
  const [mediaErrorCode, setMediaErrorCode] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setFailure(undefined);
    setMediaErrorCode(undefined);
    setPlaying(false);
  }, [identity, enabled]);

  useEffect(() => {
    if (!enabled || playing || failure) return;
    const timer = setTimeout(
      () => setFailure("startup"),
      LIVE_STARTUP_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [identity, enabled, playing, failure, attempt]);

  const onPlaying = useCallback(() => {
    setPlaying(true);
    setFailure(undefined);
    setMediaErrorCode(undefined);
  }, []);
  const onError = useCallback((reason: LivePlayerError, code?: number) => {
    setMediaErrorCode(code);
    setPlaying(false);
    setFailure(reason);
  }, []);
  const retry = useCallback(() => {
    setFailure(undefined);
    setMediaErrorCode(undefined);
    setPlaying(false);
    setAttempt((value) => value + 1);
  }, []);

  return { failure, mediaErrorCode, attempt, onPlaying, onError, retry };
}
