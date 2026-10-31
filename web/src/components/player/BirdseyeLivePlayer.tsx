import { BirdseyeConfig } from "@/types/frigateConfig";
import ActivityIndicator from "../indicators/activity-indicator";
import { JSMpegPlayer, MSEPlayer, WebRtcPlayer } from "./lazyPlayers";
import { LivePlayerMode } from "@/types/live";
import { cn } from "@/lib/utils";
import React, { Suspense } from "react";
import { ImageShadowOverlay } from "../overlay/ImageShadowOverlay";
import { onActivate } from "@/utils/fork/a11y";
import { useTranslation } from "react-i18next";

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
}: Readonly<LivePlayerProps>) {
  const { t } = useTranslation(["fork"]);
  let player;
  if (liveMode == "webrtc") {
    player = <WebRtcPlayer className="size-full" camera="birdseye" pip={pip} />;
  } else if (liveMode == "mse") {
    if ("MediaSource" in window || "ManagedMediaSource" in window) {
      player = <MSEPlayer className="size-full" camera="birdseye" pip={pip} />;
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
        className="flex size-full justify-center overflow-hidden"
        camera="birdseye"
        width={birdseyeConfig.width}
        height={birdseyeConfig.height}
        containerRef={containerRef}
        playbackEnabled={true}
        useWebGL={true}
      />
    );
  } else {
    player = <ActivityIndicator className="w-full [.bg-black_&]:text-white" />;
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex w-full cursor-pointer justify-center overflow-hidden rounded-lg md:rounded-2xl",
        className,
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      // fork (UI155): a focusable tile needs a name, as LivePlayer's has
      aria-label={onClick ? t("a11yLabels.birdseye") : undefined}
      onKeyDown={onActivate(onClick)}
    >
      <div
        className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center [container-type:size]"
        style={
          {
            "--pic-ar":
              (birdseyeConfig.width || 1) / (birdseyeConfig.height || 1),
          } as React.CSSProperties
        }
      >
        <div className="relative aspect-[var(--pic-ar)] h-auto w-[min(100%,calc(100cqh*var(--pic-ar)))]">
          <ImageShadowOverlay />
        </div>
      </div>
      <div className="size-full" ref={playerRef}>
        <Suspense fallback={<ActivityIndicator />}>{player}</Suspense>
      </div>
    </div>
  );
}
