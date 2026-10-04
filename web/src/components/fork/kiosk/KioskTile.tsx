/**
 * One camera on the wall display (UI19): Live's player plus a name label
 * that stays readable from across a room.
 */

import { useEffect, useRef, useState } from "react";
import AutoUpdatingCameraImage from "@/components/camera/AutoUpdatingCameraImage";
import LivePlayer from "@/components/player/LivePlayer";
import { useCameraFriendlyName } from "@/hooks/use-camera-friendly-name";
import { cn } from "@/lib/utils";
import type { KioskTileStream } from "@/lib/fork/kiosk";
import type { CameraConfig } from "@/types/frigateConfig";
import type { LivePlayerError, LivePlayerMode } from "@/types/live";

type KioskTileProps = {
  camera: CameraConfig;
  stream: KioskTileStream;
  preferredLiveMode: LivePlayerMode;
  windowVisible: boolean;
  onError: (error: LivePlayerError) => void;
  onResetLiveMode: () => void;
  /** Alone on screen: a larger label. */
  large?: boolean;
  /** Hide the name label (the takeover banner already names the camera). */
  hideLabel?: boolean;
};

export default function KioskTile({
  camera,
  stream,
  preferredLiveMode,
  windowVisible,
  onError,
  onResetLiveMode,
  large = false,
  hideLabel = false,
}: Readonly<KioskTileProps>) {
  const name = useCameraFriendlyName(camera);

  // A tile that streams continuously (alone on screen, or set to) has no
  // still of its own, so it stays black until the stream's first keyframe,
  // which can take seconds. The latest still fills that gap until the video
  // plays.
  const continuous = !stream.showStillWithoutActivity;
  const streamKey = `${camera.name}/${stream.streamName}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [playingKey, setPlayingKey] = useState<string>();
  useEffect(() => {
    const root = rootRef.current;
    if (!continuous || !root) return;
    // media events do not bubble, but ancestors see them while capturing
    const onPlaying = () => setPlayingKey(streamKey);
    root.addEventListener("playing", onPlaying, true);
    return () => root.removeEventListener("playing", onPlaying, true);
  }, [continuous, streamKey]);
  const holdStill = continuous && playingKey !== streamKey;

  return (
    <div
      ref={rootRef}
      className="relative isolate size-full overflow-hidden rounded-lg bg-black"
      data-testid="kiosk-tile"
      data-camera={camera.name}
    >
      {holdStill && (
        <div
          className="pointer-events-none absolute inset-0"
          data-testid="kiosk-tile-still"
        >
          <AutoUpdatingCameraImage
            className="size-full"
            cameraClasses="relative flex size-full items-center justify-center"
            camera={camera.name}
            showFps={false}
            reloadInterval={-1}
          />
        </div>
      )}
      <LivePlayer
        className="size-full cursor-default"
        cameraConfig={camera}
        streamName={stream.streamName}
        preferredLiveMode={preferredLiveMode}
        autoLive={stream.autoLive}
        showStillWithoutActivity={stream.showStillWithoutActivity}
        useWebGL={stream.useWebGL}
        windowVisible={windowVisible}
        playInBackground={false}
        onError={onError}
        onResetLiveMode={onResetLiveMode}
      />
      {!hideLabel && (
        <div
          className={cn(
            "pointer-events-none absolute bottom-0 left-0 z-40 max-w-full truncate rounded-tr-lg bg-black/55 font-medium text-white smart-capitalize",
            large ? "px-4 py-2 text-2xl" : "px-2.5 py-1 text-sm",
          )}
          data-testid="kiosk-tile-name"
        >
          {name}
        </div>
      )}
    </div>
  );
}
