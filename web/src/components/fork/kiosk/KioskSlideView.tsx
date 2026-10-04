/**
 * One wall display slide (UI19): a grid page, a group's saved Live layout
 * scaled to the screen, or a single camera filling it.
 */

import { useCallback, useMemo } from "react";
import useSWR from "swr";
import KioskTile from "@/components/fork/kiosk/KioskTile";
import { useStreamingSettings } from "@/context/streaming-settings-provider";
import { useLiveGridLayout } from "@/hooks/fork/use-live-grid-layout";
import { useElementSize } from "@/hooks/fork/use-element-size";
import useCameraLiveMode from "@/hooks/use-camera-live-mode";
import { useUserPersistence } from "@/hooks/use-user-persistence";
import {
  CUSTOM_SOURCE,
  DEFAULT_GROUP,
  bestGridShape,
  fallbackLiveMode,
  fitSavedLayout,
  tileStream,
  type KioskSlide,
  type KioskTileStream,
  type SavedLayoutItem,
} from "@/lib/fork/kiosk";
import type { CameraConfig, FrigateConfig } from "@/types/frigateConfig";
import type { LivePlayerError, LivePlayerMode } from "@/types/live";

/** Space between tiles, in pixels. */
const GAP = 6;

type KioskSlideViewProps = {
  slide: KioskSlide;
  /** One camera filling the screen, streaming continuously. */
  single: boolean;
  /** Use the group's saved Live layout when the slide holds the group. */
  savedLayout: boolean;
  windowVisible: boolean;
  /**
   * Live modes cameras fell back to on earlier slides. A slide is remounted
   * on every visit, so the page keeps these for it and a camera starts with
   * the mode that worked instead of failing over again.
   */
  learnedModes: Partial<Record<string, LivePlayerMode>>;
  onLearnMode: (camera: string, mode: LivePlayerMode) => void;
  /** Takeover slides drop the label; the banner names the camera. */
  hideLabels?: boolean;
};

type TileProps = {
  camera: CameraConfig;
  stream: KioskTileStream;
  preferredLiveMode: LivePlayerMode;
};

export default function KioskSlideView({
  slide,
  single,
  savedLayout,
  windowVisible,
  learnedModes,
  onLearnMode,
  hideLabels = false,
}: Readonly<KioskSlideViewProps>) {
  const { data: config } = useSWR<FrigateConfig>("config");
  const [globalAutoLive] = useUserPersistence("autoLiveView", true);
  const { allGroupsStreamingSettings } = useStreamingSettings();

  const isGroup =
    slide.source !== DEFAULT_GROUP && slide.source !== CUSTOM_SOURCE;
  const groupSettings = isGroup
    ? allGroupsStreamingSettings[slide.source]
    : undefined;

  const cameras = useMemo(
    () =>
      slide.cameras.flatMap((name) => {
        const camera = config?.cameras[name];
        return camera ? [camera] : [];
      }),
    [config, slide.cameras],
  );

  const streams = useMemo(() => {
    const result: Partial<Record<string, KioskTileStream>> = {};
    for (const camera of cameras) {
      result[camera.name] = tileStream(
        camera.live.streams,
        groupSettings?.[camera.name],
        globalAutoLive ?? true,
        single,
      );
    }
    return result;
  }, [cameras, groupSettings, globalAutoLive, single]);

  const activeStreams = useMemo(() => {
    const result: Record<string, string> = {};
    for (const [camera, stream] of Object.entries(streams)) {
      if (stream) result[camera] = stream.streamName;
    }
    return result;
  }, [streams]);

  // A learned fallback goes in as the requested mode, so the mode resolver
  // still checks it (WebRTC only while usable) and the reset a tile asks for
  // when it drops back to its still keeps it.
  const preferredModes = useMemo(() => {
    const result: Record<string, LivePlayerMode | undefined> = {};
    for (const camera of cameras) {
      result[camera.name] =
        learnedModes[camera.name] ?? groupSettings?.[camera.name]?.playerMode;
    }
    return result;
  }, [cameras, groupSettings, learnedModes]);

  const { preferredLiveModes, resetPreferredLiveMode, webRTCUsableStates } =
    useCameraLiveMode(cameras, windowVisible, activeStreams, preferredModes);

  // a camera has no entry until its mode is worked out
  const resolvedModes: Partial<Record<string, LivePlayerMode>> =
    preferredLiveModes;

  const handleError = useCallback(
    (camera: string, error: LivePlayerError) => {
      onLearnMode(
        camera,
        fallbackLiveMode(error, webRTCUsableStates[camera] ?? false),
      );
    },
    [onLearnMode, webRTCUsableStates],
  );

  const tile = (props: TileProps) => (
    <KioskTile
      camera={props.camera}
      stream={props.stream}
      preferredLiveMode={props.preferredLiveMode}
      windowVisible={windowVisible}
      large={single}
      hideLabel={hideLabels}
      onError={(error) => handleError(props.camera.name, error)}
      onResetLiveMode={() => resetPreferredLiveMode(props.camera.name)}
    />
  );

  const tiles: TileProps[] = cameras.flatMap((camera) => {
    const stream = streams[camera.name];
    if (!stream) return [];
    const mode = resolvedModes[camera.name];
    // Show the still until the camera's live mode is known: a tile that
    // streams at once would otherwise try MSE first, which fails for a
    // camera go2rtc does not restream.
    return [
      {
        camera,
        stream: mode
          ? stream
          : { ...stream, autoLive: false, showStillWithoutActivity: true },
        preferredLiveMode: mode ?? "mse",
      },
    ];
  });

  const [layout, , layoutLoaded] = useLiveGridLayout(slide.source);

  const [containerRef, { width, height }] = useElementSize<HTMLDivElement>();

  const useSaved = !single && savedLayout && isGroup && slide.pages === 1;
  const fitted = useMemo(() => {
    if (!useSaved || !layout) return undefined;
    const shown = new Set(slide.cameras);
    const items: SavedLayoutItem[] = layout
      .filter((item) => shown.has(item.i))
      .map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
    // A layout missing some cameras would hide them; use the grid instead.
    if (items.length !== shown.size) return undefined;
    return fitSavedLayout(items, width, height);
  }, [useSaved, layout, slide.cameras, width, height]);

  // Wait for the saved layout instead of flashing the plain grid first.
  const waitingForLayout = useSaved && !layoutLoaded;
  let content: React.ReactNode = null;
  if (single) {
    const only = tiles.at(0);
    content = only ? (
      <div className="absolute inset-0">{tile(only)}</div>
    ) : null;
  } else if (fitted && !waitingForLayout) {
    content = (
      <div
        className="relative"
        style={{ width: fitted.width, height: fitted.height }}
        data-testid="kiosk-saved-layout"
      >
        {fitted.tiles.map((placed) => {
          const props = tiles.find(
            (item) => item.camera.name === placed.camera,
          );
          return props ? (
            <div
              key={placed.camera}
              className="absolute"
              style={{
                left: `${placed.left * 100}%`,
                top: `${placed.top * 100}%`,
                width: `${placed.width * 100}%`,
                height: `${placed.height * 100}%`,
                padding: GAP / 2,
              }}
            >
              {tile(props)}
            </div>
          ) : null;
        })}
      </div>
    );
  } else if (!waitingForLayout) {
    const shape = bestGridShape(tiles.length, width, height, GAP);
    content = (
      <div
        className="flex flex-wrap content-center justify-center"
        style={{
          gap: GAP,
          width: shape.cols * shape.cellWidth + (shape.cols - 1) * GAP,
        }}
        data-testid="kiosk-grid"
        data-cols={shape.cols}
      >
        {tiles.map((props) => (
          <div
            key={props.camera.name}
            style={{ width: shape.cellWidth, height: shape.cellHeight }}
          >
            {tile(props)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={
        single
          ? "absolute inset-0"
          : "absolute inset-0 m-1.5 flex items-center justify-center"
      }
    >
      {(width > 0 && height > 0) || single ? content : null}
    </div>
  );
}
