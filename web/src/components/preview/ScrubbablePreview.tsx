import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApiHost } from "@/api";
import useSWR from "swr";
import { isFirefox, isMobile, isSafari } from "react-device-detect";
import { TimelineScrubMode, TimeRange } from "@/types/timeline";
import { NoThumbSlider } from "../ui/slider";
import { PREVIEW_FPS, PREVIEW_PADDING, Preview } from "@/types/preview";
import { baseUrl } from "@/api/baseUrl";
import { useTranslation } from "react-i18next";

type VideoPreviewProps = {
  relevantPreview: Preview;
  startTime: number;
  endTime?: number;
  showProgress?: boolean;
  loop?: boolean;
  setReviewed: () => void;
  setIgnoreClick: (ignore: boolean) => void;
  isPlayingBack: (ended: boolean) => void;
  onTimeUpdate?: (time: number | undefined) => void;
  windowVisible: boolean;
};
export function VideoPreview({
  relevantPreview,
  startTime,
  endTime,
  showProgress = true,
  loop = false,
  setReviewed,
  setIgnoreClick,
  isPlayingBack,
  onTimeUpdate,
  windowVisible,
}: Readonly<VideoPreviewProps>) {
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);

  // keep track of playback state

  const [progress, setProgress] = useState(0);
  const [hoverTimeout, setHoverTimeout] = useState<NodeJS.Timeout>();
  const playerStartTime = useMemo(() => {
    if (!relevantPreview) {
      return 0;
    }

    // start with a bit of padding
    return Math.max(0, startTime - relevantPreview.start - PREVIEW_PADDING);

    // we know that these deps are correct
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const playerDuration = useMemo(
    () => (endTime ?? relevantPreview.end) - startTime + PREVIEW_PADDING,
    // we know that these deps are correct
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [lastPercent, setLastPercent] = useState(0.0);

  // initialize player correctly

  useEffect(() => {
    if (!playerRef.current) {
      return;
    }

    if (isSafari || (isFirefox && isMobile)) {
      playerRef.current.pause();
      setPlaybackMode("compat");
    } else {
      playerRef.current.currentTime = playerStartTime;
      playerRef.current.playbackRate = PREVIEW_FPS;
    }

    // we know that these deps are correct
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerRef]);

  // time progress update

  const onProgress = useCallback(() => {
    if (!windowVisible) {
      return;
    }

    if (onTimeUpdate) {
      onTimeUpdate(
        relevantPreview.start + (playerRef.current?.currentTime || 0),
      );
    }

    const playerProgress =
      (playerRef.current?.currentTime || 0) - playerStartTime;

    // end with a bit of padding
    const playerPercent = (playerProgress / playerDuration) * 100;

    if (setReviewed && lastPercent < 50 && playerPercent > 50) {
      setReviewed();
    }

    setLastPercent(playerPercent);

    if (playerPercent > 100) {
      setReviewed();

      if (loop && playerRef.current) {
        if (playbackMode != "auto") {
          setPlaybackMode("auto");
          setTimeout(() => setPlaybackMode("compat"), 100);
        }

        playerRef.current.currentTime = playerStartTime;
        return;
      }

      if (isMobile) {
        isPlayingBack(false);

        if (onTimeUpdate) {
          onTimeUpdate(undefined);
        }
      } else {
        playerRef.current?.pause();
      }

      setPlaybackMode("auto");
      setProgress(100.0);
    } else {
      setProgress(playerPercent);
    }

    // we know that these deps are correct
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setProgress, lastPercent, windowVisible]);

  // manual playback
  // safari is incapable of playing at a speed > 2x
  // so manual seeking is required on iOS

  const [playbackMode, setPlaybackMode] = useState<TimelineScrubMode>("auto");

  useEffect(() => {
    if (playbackMode != "compat" || !playerRef.current) {
      return;
    }

    let counter = 0;
    const intervalId: NodeJS.Timeout = setInterval(() => {
      if (playerRef.current) {
        playerRef.current.currentTime = playerStartTime + counter;
        counter += 1;
      }
    }, 1000 / PREVIEW_FPS);
    return () => clearInterval(intervalId);

    // we know that these deps are correct
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackMode, playerRef]);

  // user interaction

  useEffect(() => {
    setIgnoreClick(playbackMode != "auto" && playbackMode != "compat");
  }, [playbackMode, setIgnoreClick]);

  const onManualSeek = useCallback(
    (values: number[]) => {
      const value = values[0];

      if (!playerRef.current) {
        return;
      }

      if (playerRef.current.paused == false) {
        playerRef.current.pause();
      }

      if (setReviewed) {
        setReviewed();
      }

      setProgress(value);
      playerRef.current.currentTime =
        playerStartTime + (value / 100.0) * playerDuration;
    },

    // we know that these deps are correct
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playerDuration, playerRef, playerStartTime, setIgnoreClick],
  );

  const onStopManualSeek = useCallback(() => {
    setTimeout(() => {
      setHoverTimeout(undefined);

      if (isSafari || (isFirefox && isMobile)) {
        setPlaybackMode("compat");
      } else {
        setPlaybackMode("auto");
        void playerRef.current?.play();
      }
    }, 500);
  }, [playerRef]);

  const onProgressHover = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!sliderRef.current) {
        return;
      }

      const rect = sliderRef.current.getBoundingClientRect();
      const positionX = event.clientX - rect.left;
      const width = sliderRef.current.clientWidth;
      onManualSeek([Math.round((positionX / width) * 100)]);

      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
      }
    },
    [sliderRef, hoverTimeout, onManualSeek],
  );

  return (
    <div className="relative aspect-video size-full bg-black">
      <video
        ref={playerRef}
        className="pointer-events-none aspect-video size-full bg-black"
        autoPlay
        playsInline
        preload="auto"
        muted
        onTimeUpdate={onProgress}
      >
        <source
          src={`${baseUrl}${relevantPreview.src.substring(1)}`}
          type={relevantPreview.type}
        />
      </video>
      {showProgress && (
        <NoThumbSlider
          ref={sliderRef}
          className={`absolute inset-x-0 bottom-0 z-30 cursor-col-resize ${playbackMode == "hover" || playbackMode == "drag" ? "h-4" : "h-2"}`}
          value={[progress]}
          onValueChange={(event) => {
            setPlaybackMode("drag");
            onManualSeek(event);
          }}
          onValueCommit={onStopManualSeek}
          min={0}
          step={1}
          max={100}
          onMouseMove={
            isMobile
              ? undefined
              : (event) => {
                  if (playbackMode != "drag") {
                    setPlaybackMode("hover");
                    onProgressHover(event);
                  }
                }
          }
          onMouseLeave={
            isMobile
              ? undefined
              : () => {
                  if (!sliderRef.current) {
                    return;
                  }

                  setHoverTimeout(setTimeout(() => onStopManualSeek(), 500));
                }
          }
        />
      )}
    </div>
  );
}

const MIN_LOAD_TIMEOUT_MS = 200;
type InProgressPreviewProps = {
  camera: string;
  startTime: number;
  endTime?: number;
  timeRange: TimeRange;
  showProgress?: boolean;
  loop?: boolean;
  defaultImageUrl?: string;
  setReviewed: () => void;
  setIgnoreClick: (ignore: boolean) => void;
  isPlayingBack: (ended: boolean) => void;
  onTimeUpdate?: (time: number | undefined) => void;
  windowVisible: boolean;
};
export function InProgressPreview({
  camera,
  startTime,
  endTime,
  timeRange,
  showProgress = true,
  loop = false,
  defaultImageUrl,
  setReviewed,
  setIgnoreClick,
  isPlayingBack,
  onTimeUpdate,
  windowVisible,
}: Readonly<InProgressPreviewProps>) {
  const { t } = useTranslation(["common"]);
  const apiHost = useApiHost();
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const { data: previewFrames } = useSWR<string[]>(
    `preview/${camera}/start/${Math.floor(startTime) - PREVIEW_PADDING}/end/${Math.ceil(
      endTime ?? timeRange.before,
    )}/frames`,
    { revalidateOnFocus: false },
  );

  const [playbackMode, setPlaybackMode] = useState<TimelineScrubMode>("auto");
  const [hoverTimeout, setHoverTimeout] = useState<NodeJS.Timeout>();
  const [key, setKey] = useState(0);
  const [failedFrame, setFailedFrame] = useState<string>();

  // Resume a decoded frame without seeking to an invalid preceding index.
  const [loadedKey, setLoadedKey] = useState<number>();

  useEffect(() => {
    if (!previewFrames || !windowVisible || loadedKey !== key) {
      return;
    }
    onTimeUpdate?.(startTime - PREVIEW_PADDING + key);
    if (playbackMode != "auto") {
      return;
    }
    if (key == previewFrames.length - 1) {
      setReviewed();
      if (loop) {
        setKey(0);
      } else if (isMobile) {
        isPlayingBack(false);
        onTimeUpdate?.(undefined);
      }
      return;
    }
    const timeout = setTimeout(() => {
      if (key == Math.floor(previewFrames.length / 2)) {
        setReviewed();
      }
      setKey(key + 1);
    }, MIN_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [
    key,
    loadedKey,
    playbackMode,
    previewFrames,
    windowVisible,
    startTime,
    onTimeUpdate,
    setReviewed,
    loop,
    isPlayingBack,
  ]);

  const clampFrame = useCallback(
    (value: number) =>
      Math.max(0, Math.min(value, (previewFrames?.length ?? 1) - 1)),
    [previewFrames],
  );

  // user interaction

  useEffect(() => {
    setIgnoreClick(playbackMode != "auto");
  }, [playbackMode, setIgnoreClick]);

  const onManualSeek = useCallback(
    (values: number[]) => {
      const value = values[0];
      setReviewed();
      setKey(clampFrame(value));
    },

    // we know that these deps are correct
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setIgnoreClick, setKey, clampFrame],
  );

  const onStopManualSeek = useCallback(
    (values: number[]) => {
      const value = values[0];
      setTimeout(() => {
        setPlaybackMode("auto");
        setKey(clampFrame(value));
      }, 500);
    },
    [setPlaybackMode, clampFrame],
  );

  const onProgressHover = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!sliderRef.current || !previewFrames) {
        return;
      }

      const rect = sliderRef.current.getBoundingClientRect();
      const positionX = event.clientX - rect.left;
      const width = sliderRef.current.clientWidth;
      const progress = [
        Math.round((positionX / width) * (previewFrames.length - 1)),
      ];
      onManualSeek(progress);

      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
      }
    },
    [sliderRef, hoverTimeout, previewFrames, onManualSeek],
  );

  if (!previewFrames || previewFrames.length == 0) {
    return (
      <img
        className="size-full"
        src={defaultImageUrl}
        alt={t("image.previewFrom", { camera })}
      />
    );
  }

  return (
    <div className="relative flex size-full items-center bg-black">
      <img
        className="pointer-events-none size-full object-contain"
        src={
          failedFrame === previewFrames[key]
            ? defaultImageUrl
            : `${apiHost}api/preview/${previewFrames[key]}/thumbnail.webp`
        }
        onError={() => setFailedFrame(previewFrames[key])}
        alt={t("image.previewFrom", { camera })}
        onLoad={() => {
          if (failedFrame !== previewFrames[key]) setLoadedKey(key);
        }}
      />
      {showProgress && (
        <NoThumbSlider
          ref={sliderRef}
          className={`absolute inset-x-0 bottom-0 z-30 cursor-col-resize ${playbackMode != "auto" ? "h-4" : "h-2"}`}
          value={[key]}
          onValueChange={(event) => {
            setPlaybackMode("drag");
            onManualSeek(event);
          }}
          onValueCommit={onStopManualSeek}
          min={0}
          step={1}
          max={previewFrames.length - 1}
          onMouseMove={
            isMobile
              ? undefined
              : (event) => {
                  if (playbackMode != "drag") {
                    setPlaybackMode("hover");
                    onProgressHover(event);
                  }
                }
          }
          onMouseLeave={
            isMobile
              ? undefined
              : (event) => {
                  if (!sliderRef.current || !previewFrames) {
                    return;
                  }

                  const rect = sliderRef.current.getBoundingClientRect();
                  const positionX = event.clientX - rect.left;
                  const width = sliderRef.current.clientWidth;
                  const progress = [
                    Math.round(
                      (positionX / width) * (previewFrames.length - 1),
                    ),
                  ];

                  setHoverTimeout(
                    setTimeout(() => onStopManualSeek(progress), 500),
                  );
                }
          }
        />
      )}
    </div>
  );
}
