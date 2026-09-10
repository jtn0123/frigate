import { BirdseyeConfig } from "@/types/frigateConfig";
import ActivityIndicator from "../indicators/activity-indicator";
import { JSMpegPlayer, MSEPlayer, WebRtcPlayer } from "./lazyPlayers";
import { LivePlayerMode } from "@/types/live";
import { cn } from "@/lib/utils";
import React, { Suspense } from "react";
import { ImageShadowOverlay } from "../overlay/ImageShadowOverlay";
import { onActivate } from "@/utils/fork/a11y";

type LivePlayerProps = {
  className?: string;
  birdseyeConfig: BirdseyeConfig;
  liveMode: LivePlayerMode;
  pip?: boolean;
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  playerRef?: React.MutableRefObject<HTMLDivElement | null>;
  onClick?: () => void;
};

export default function BirdseyeLivePlayer({
  className,
  birdseyeConfig,
  liveMode,
  pip,
  containerRef,
  playerRef,
  onClick,
}: LivePlayerProps) {
  let player;
  if (liveMode == "webrtc") {
    player = (
      <WebRtcPlayer
        className={`size-full rounded-lg md:rounded-2xl`}
        camera="birdseye"
        pip={pip}
      />
    );
  } else if (liveMode == "mse") {
    if ("MediaSource" in window || "ManagedMediaSource" in window) {
      player = (
        <MSEPlayer
          className={`size-full rounded-lg md:rounded-2xl`}
          camera="birdseye"
          pip={pip}
        />
      );
    } else {
      player = (
        <div className="w-5xl text-center text-sm">
          iOS 17.1 or greater is required for this live stream type.
        </div>
      );
    }
  } else if (liveMode == "jsmpeg") {
    player = (
      <JSMpegPlayer
        className="flex size-full justify-center overflow-hidden rounded-lg md:rounded-2xl"
        camera="birdseye"
        width={birdseyeConfig.width}
        height={birdseyeConfig.height}
        containerRef={containerRef}
        playbackEnabled={true}
        useWebGL={true}
      />
    );
  } else {
    player = <ActivityIndicator />;
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex w-full cursor-pointer justify-center",
        className,
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onActivate(onClick)}
    >
      <ImageShadowOverlay
        upperClassName="md:rounded-2xl"
        lowerClassName="md:rounded-2xl"
      />
      <div className="size-full" ref={playerRef}>
        <Suspense fallback={<ActivityIndicator />}>{player}</Suspense>
      </div>
    </div>
  );
}
