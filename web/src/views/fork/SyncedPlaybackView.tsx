/**
 * Fork (UI143): synced multi-camera playback for the recording view.
 *
 * Shows two to four cameras' recordings as full players side by side, all
 * following one master clock. The recording view's timeline, play and
 * pause, steps and speed drive the whole grid; each tile maps the master
 * time through its own player. A tile without footage at the master time
 * shows a "No recording" card and rejoins when its footage resumes.
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import useSWR from "swr";
import {
  LuCheck,
  LuLayoutGrid,
  LuMaximize2,
  LuMinimize2,
  LuPlus,
  LuRadio,
  LuVideoOff,
  LuX,
} from "react-icons/lu";
import DynamicVideoPlayer from "@/components/player/dynamic/DynamicVideoPlayer";
import type { DynamicVideoController } from "@/components/player/dynamic/DynamicVideoController";
import VideoControls from "@/components/player/VideoControls";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { CameraNameLabel } from "@/components/camera/FriendlyNameLabel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DetailStreamProvider } from "@/context/detail-stream-context";
import { useOverlayState } from "@/hooks/use-overlay-state";
import { useUserPersistence } from "@/hooks/use-user-persistence";
import { use24HourTime } from "@/hooks/use-date-utils";
import { useDateLocale } from "@/hooks/use-date-locale";
import { resolveCameraName } from "@/hooks/use-camera-friendly-name";
import { useIsMobile } from "@/hooks/fork/use-viewport";
import {
  useSyncedPlayback,
  useSyncedPlaybackRate,
} from "@/hooks/fork/use-synced-playback";
import {
  clampSelection,
  fitBox,
  MAX_SYNCED_TILES,
  MAX_SYNCED_TILES_PHONE,
  mergeSpans,
  pickDefaultCameras,
  pickGridLayout,
  type PlaybackControllerLike,
  SYNCED_PLAYBACK_RATES,
  type TimeSpan,
} from "@/lib/fork/synced-playback";
import type {
  SyncedPlaybackEngine,
  SyncedTileState,
} from "@/lib/fork/synced-playback-engine";
import { fullscreenPortalContainer } from "@/lib/fork/fullscreen";
import { cn } from "@/lib/utils";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { VideoResolutionType } from "@/types/live";
import type { Preview } from "@/types/preview";
import type { PlaybackQuality, RecordingCoverage } from "@/types/record";
import type { ReviewSegment } from "@/types/review";
import type { TimeRange } from "@/types/timeline";
import { formatUnixTimestampToDateTime } from "@/utils/dateUtil";

const GRID_GAP_PX = 8;

export type SyncedPlaybackViewProps = {
  /** The cameras the view may show (the current group or filter). */
  cameras: readonly string[];
  mainCamera: string;
  onSelectCamera: (camera: string) => void;
  /** The hour chunk being played. */
  timeRange: TimeRange;
  latestTime: number;
  previews: Preview[];
  reviewItems?: ReviewSegment[];
  /** The view's playback start (its players' startTimestamp). */
  startTimestamp: number;
  currentTime: number;
  isScrubbing: boolean;
  /** The main camera's quality pin. */
  quality?: PlaybackQuality;
  hotKeys: boolean;
  onTimestampUpdate: (time: number) => void;
  onSeekToTime: (time: number, play?: boolean) => void;
  onClipEnded: () => void;
  onControllerReady: (controller: PlaybackControllerLike) => void;
};

export default function SyncedPlaybackView({
  cameras,
  mainCamera,
  onSelectCamera,
  timeRange,
  latestTime,
  previews,
  reviewItems,
  startTimestamp,
  currentTime,
  isScrubbing,
  quality,
  hotKeys,
  onTimestampUpdate,
  onSeekToTime,
  onClipEnded,
  onControllerReady,
}: Readonly<SyncedPlaybackViewProps>) {
  const { t } = useTranslation(["fork"]);
  const { data: config } = useSWR<FrigateConfig>("config");
  const isPhone = useIsMobile();
  const max = isPhone ? MAX_SYNCED_TILES_PHONE : MAX_SYNCED_TILES;

  // tiles

  const gridCameras = useMemo(
    () => cameras.filter((camera) => camera != "birdseye"),
    [cameras],
  );
  const [openedAt] = useState(startTimestamp);
  const [chosen, setChosen] = useState<string[] | undefined>(undefined);

  // until the user edits the grid it follows the activity around the
  // moment it opened at, which may load after the grid does
  const tiles = useMemo(() => {
    const base =
      chosen ??
      pickDefaultCameras({
        mainCamera,
        cameras: gridCameras,
        activity: reviewItems ?? [],
        time: openedAt,
        max,
      });

    return clampSelection(
      base.includes(mainCamera) ? base : [mainCamera, ...base],
      gridCameras,
      max,
    );
  }, [chosen, mainCamera, gridCameras, reviewItems, openedAt, max]);

  const toggleCamera = useCallback(
    (camera: string, on: boolean) => {
      setChosen(
        on ? [...tiles, camera] : tiles.filter((tile) => tile != camera),
      );
    },
    [tiles],
  );

  // the default puts the main camera first; promoting keeps every tile in
  // place instead, so the second click of a double-click lands on the
  // same tile and the clicked camera never moves away from the pointer
  const promote = useCallback(
    (camera: string) => {
      setChosen(tiles);
      onSelectCamera(camera);
    },
    [tiles, onSelectCamera],
  );

  // master clock

  const [rate, setRate] = useSyncedPlaybackRate();
  const [persistedMuted, setPersistedMuted] = useUserPersistence(
    "hlsPlayerMuted",
    true,
  );
  const [volume] = useOverlayState<number>("playerVolume", 1.0);

  const { engine, snapshot } = useSyncedPlayback({
    cameras: tiles,
    mainCamera,
    timeRange,
    latestTime,
    isScrubbing,
    rate,
    muted: persistedMuted ?? true,
    startTimestamp,
    onTimestampUpdate,
    onSeekToTime,
    onClipEnded,
  });

  useEffect(() => {
    onControllerReady(engine);
  }, [engine, onControllerReady]);

  // a seek into another chunk moved the view's start inside it before the
  // grid caught up; the tiles load around it instead of the old anchor
  const tileStart =
    snapshot.anchor >= timeRange.after && snapshot.anchor <= timeRange.before
      ? snapshot.anchor
      : startTimestamp;

  // layout

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [gridElement, setGridElement] = useState<HTMLFieldSetElement | null>(
    null,
  );
  const gridSize = useElementSize(gridElement);
  const fullscreen = useElementFullscreen();
  const [pickerOpen, setPickerOpen] = useState(false);

  const aspectOf = useCallback(
    (camera: string) => {
      const detect = config?.cameras[camera]?.detect;
      return detect?.width && detect.height
        ? detect.width / detect.height
        : 16 / 9;
    },
    [config],
  );

  const layout = useMemo(
    () =>
      pickGridLayout(
        tiles.length,
        gridSize.width,
        gridSize.height,
        tiles.reduce((sum, camera) => sum + aspectOf(camera), 0) /
          Math.max(1, tiles.length),
        GRID_GAP_PX,
      ),
    [tiles, gridSize, aspectOf],
  );

  const cell = {
    width: (gridSize.width - GRID_GAP_PX * (layout.cols - 1)) / layout.cols,
    height: (gridSize.height - GRID_GAP_PX * (layout.rows - 1)) / layout.rows,
  };
  const showAddCell =
    tiles.length < max &&
    tiles.length < gridCameras.length &&
    layout.cols * layout.rows > tiles.length;

  return (
    <div
      ref={rootRef}
      data-testid="synced-playback"
      className={cn(
        "flex size-full min-h-0 flex-col gap-2 bg-background",
        isPhone && "portrait:h-[50dvh]",
      )}
    >
      <fieldset
        ref={setGridElement}
        aria-label={t("syncedPlayback.grid")}
        className="relative grid min-h-0 min-w-0 flex-1"
        style={{
          gap: GRID_GAP_PX,
          gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
        }}
      >
        {tiles.map((camera) => (
          <SyncedTile
            key={camera}
            camera={camera}
            isMain={camera == mainCamera}
            engine={engine}
            config={config}
            timeRange={timeRange}
            startTimestamp={tileStart}
            previews={previews}
            isScrubbing={isScrubbing}
            quality={camera == mainCamera ? quality : undefined}
            tileState={snapshot.tileStates[camera]}
            cell={cell}
            aspect={aspectOf(camera)}
            canRemove={camera != mainCamera}
            fullscreenElement={fullscreen.element}
            onToggleFullscreen={fullscreen.toggle}
            onPromote={() => promote(camera)}
            onRemove={() => toggleCamera(camera, false)}
            onSeekToTime={onSeekToTime}
          />
        ))}
        {showAddCell && (
          <button
            type="button"
            data-testid="synced-playback-add"
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-secondary-foreground/30 text-sm text-muted-foreground hover:bg-secondary/40"
            onClick={() => setPickerOpen(true)}
          >
            <LuPlus className="size-6" />
            {t("syncedPlayback.picker.add")}
          </button>
        )}
      </fieldset>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1">
        <SyncedCameraPicker
          cameras={gridCameras}
          tiles={tiles}
          mainCamera={mainCamera}
          max={max}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onToggle={toggleCamera}
          portal={fullscreenPortalContainer(fullscreen.element != null)}
        />
        <VideoControls
          className="relative"
          video={snapshot.mainVideo}
          features={{
            volume: true,
            seek: true,
            playbackRate: true,
            fullscreen: true,
          }}
          isPlaying={snapshot.playing}
          show
          muted={persistedMuted ?? true}
          volume={volume ?? 1}
          playbackRates={SYNCED_PLAYBACK_RATES}
          playbackRate={rate}
          hotKeys={hotKeys}
          fullscreen={fullscreen.element === rootRef.current}
          setMuted={setPersistedMuted}
          onPlayPause={(play) => (play ? engine.play() : engine.pause())}
          onSeek={(diff) => engine.step(diff)}
          onSetPlaybackRate={setRate}
          toggleFullscreen={() => fullscreen.toggle(rootRef.current)}
          containerRef={rootRef}
        />
        <SyncedClockReadout
          config={config}
          time={currentTime}
          syncing={snapshot.playing && snapshot.holding}
        />
      </div>
    </div>
  );
}

type SyncedTileProps = {
  camera: string;
  isMain: boolean;
  engine: SyncedPlaybackEngine;
  config: FrigateConfig | undefined;
  timeRange: TimeRange;
  startTimestamp: number;
  previews: Preview[];
  isScrubbing: boolean;
  quality: PlaybackQuality | undefined;
  tileState: SyncedTileState | undefined;
  cell: { width: number; height: number };
  aspect: number;
  canRemove: boolean;
  fullscreenElement: Element | null;
  onToggleFullscreen: (element: HTMLElement | null) => void;
  onPromote: () => void;
  onRemove: () => void;
  onSeekToTime: (time: number, play?: boolean) => void;
};

function SyncedTile({
  camera,
  isMain,
  engine,
  config,
  timeRange,
  startTimestamp,
  previews,
  isScrubbing,
  quality,
  tileState,
  cell,
  aspect,
  canRemove,
  fullscreenElement,
  onToggleFullscreen,
  onPromote,
  onRemove,
  onSeekToTime,
}: Readonly<SyncedTileProps>) {
  const { t } = useTranslation(["fork"]);
  const name = resolveCameraName(config, camera);
  const cellRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<DynamicVideoController | undefined>(undefined);
  const [resolution, setResolution] = useState<VideoResolutionType>({
    width: 0,
    height: 0,
  });

  // coverage of the whole chunk: gaps, and whether a sub stream exists

  const { data: coverage } = useSWR<RecordingCoverage>([
    `${camera}/recordings/coverage`,
    { before: timeRange.before, after: timeRange.after },
  ]);

  // the main tile keeps the view's pin; the others prefer the light stream
  const tileQuality: PlaybackQuality =
    quality ??
    (config?.cameras[camera]?.record.sub.enabled && coverage?.streams.sub
      ? "sub"
      : "auto");

  const spans = useMemo<TimeSpan[] | undefined>(() => {
    if (!coverage) {
      return undefined;
    }

    const stream = tileQuality == "auto" ? undefined : tileQuality;
    return mergeSpans(
      coverage.spans.filter(
        (span) => stream === undefined || span.streams.includes(stream),
      ),
    );
  }, [coverage, tileQuality]);

  useEffect(() => {
    const controller = controllerRef.current;
    engine.registerTile(camera, {
      ...(controller ? { controller } : {}),
      container: playerRef.current,
    });
    return () => engine.unregisterTile(camera);
  }, [engine, camera]);

  useEffect(() => {
    engine.setTileCoverage(camera, spans);
  }, [engine, camera, spans]);

  const fullscreen =
    fullscreenElement != null && fullscreenElement === cellRef.current;
  const tileAspect =
    resolution.width && resolution.height
      ? resolution.width / resolution.height
      : aspect;
  const box = fullscreen
    ? fitBox(window.innerWidth, window.innerHeight, tileAspect)
    : fitBox(cell.width, cell.height, tileAspect);

  const player = (
    <DynamicVideoPlayer
      className="size-full"
      camera={camera}
      timeRange={timeRange}
      cameraPreviews={previews}
      startTimestamp={startTimestamp}
      isScrubbing={isScrubbing}
      hotKeys={false}
      supportsFullscreen={false}
      fullscreen={false}
      onControllerReady={(controller) => {
        controllerRef.current = controller;
        engine.registerTile(camera, { controller });
      }}
      onTimestampUpdate={(time) => engine.reportTileTime(camera, time)}
      onSeekToTime={onSeekToTime}
      setFullResolution={setResolution}
      toggleFullscreen={() => onToggleFullscreen(cellRef.current)}
      quality={tileQuality}
    />
  );

  return (
    <div
      ref={cellRef}
      data-testid={`synced-tile-${camera}`}
      data-main={isMain}
      data-gap={tileState?.gap ?? false}
      className={cn(
        "flex min-h-0 min-w-0 items-center justify-center",
        // a fullscreen tile letterboxes on black like a single player
        fullscreen ? "bg-black" : "bg-background",
      )}
    >
      <div
        ref={playerRef}
        className={cn(
          "relative overflow-hidden",
          // the grid has one control bar; the players' own bars stay hidden
          "[&>div.z-50]:hidden",
          !fullscreen && "rounded-lg md:rounded-2xl",
          isMain && !fullscreen && "ring-2 ring-selected",
        )}
        style={{ width: box.width, height: box.height }}
      >
        {isMain ? (
          player
        ) : (
          <DetailStreamProvider
            isDetailMode={false}
            currentTime={0}
            camera={camera}
          >
            {player}
          </DetailStreamProvider>
        )}
        {tileState?.gap && (
          <SyncedGapCard
            camera={camera}
            config={config}
            nextStart={tileState.nextStart}
            liveEdge={tileState.liveEdge}
          />
        )}
        <button
          type="button"
          className="absolute inset-0 z-10 cursor-pointer"
          aria-label={
            isMain
              ? t("syncedPlayback.tile.isMain", { camera: name })
              : t("syncedPlayback.tile.promote", { camera: name })
          }
          aria-pressed={isMain}
          onClick={() => {
            if (!isMain) {
              onPromote();
            }
          }}
          onDoubleClick={() => onToggleFullscreen(cellRef.current)}
        />
        <div className="pointer-events-none absolute inset-x-2 top-2 z-20 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 rounded-md bg-background/70 px-2 py-1 text-xs text-primary">
            <span className="truncate smart-capitalize">{name}</span>
            {isMain && (
              <span className="rounded bg-selected px-1 text-[10px] font-semibold uppercase text-selected-foreground">
                {t("syncedPlayback.tile.main")}
              </span>
            )}
          </div>
          <div className="pointer-events-auto flex items-center gap-1 [@media(pointer:coarse)]:-m-2 [@media(pointer:coarse)]:gap-0">
            <TileButton
              label={
                fullscreen
                  ? t("syncedPlayback.tile.exitFullscreen", { camera: name })
                  : t("syncedPlayback.tile.fullscreen", { camera: name })
              }
              onClick={() => onToggleFullscreen(cellRef.current)}
            >
              {fullscreen ? <LuMinimize2 /> : <LuMaximize2 />}
            </TileButton>
            {canRemove && (
              <TileButton
                label={t("syncedPlayback.tile.remove", { camera: name })}
                onClick={onRemove}
              >
                <LuX />
              </TileButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A 28 px chip. On a touch screen the button around it is 44 px, so a near
 * miss does not land on the tile's promote button underneath.
 */
function TileButton({
  label,
  onClick,
  children,
}: Readonly<{ label: string; onClick: () => void; children: ReactNode }>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="group/tile-button flex size-7 items-center justify-center text-primary [@media(pointer:coarse)]:size-11"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <span className="flex size-7 items-center justify-center rounded-md bg-background/70 group-hover/tile-button:bg-background [&>svg]:size-4">
        {children}
      </span>
    </button>
  );
}

function useClockFormat(config: FrigateConfig | undefined) {
  const { t } = useTranslation(["common"]);
  const is24Hour = use24HourTime(config);
  const locale = useDateLocale();

  const timezone = config?.ui.timezone;

  return useCallback(
    (time: number) =>
      formatUnixTimestampToDateTime(time, {
        ...(timezone ? { timezone } : {}),
        date_format: is24Hour
          ? t("time.formattedTimestampHourMinuteSecond.24hour", {
              ns: "common",
            })
          : t("time.formattedTimestampHourMinuteSecond.12hour", {
              ns: "common",
            }),
        locale,
      }),
    [timezone, is24Hour, locale, t],
  );
}

function SyncedGapCard({
  camera,
  config,
  nextStart,
  liveEdge,
}: Readonly<{
  camera: string;
  config: FrigateConfig | undefined;
  nextStart: number | undefined;
  liveEdge: boolean;
}>) {
  const { t } = useTranslation(["fork"]);
  const navigate = useNavigate();
  const format = useClockFormat(config);

  // above the tile's promote button, which still takes clicks around the
  // card's own button; the border keeps the tile's edge visible on a light
  // page, where the card is nearly the page's own color
  return (
    <div
      data-testid="synced-gap"
      data-live-edge={liveEdge}
      className="pointer-events-none absolute inset-0 z-[15] flex flex-col items-center justify-center gap-1 rounded-[inherit] border border-border bg-background_alt p-2 text-center"
    >
      {liveEdge ? (
        <>
          <LuRadio className="size-6 text-muted-foreground" />
          <div className="text-sm font-medium text-primary">
            {t("syncedPlayback.gap.liveEdge")}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="pointer-events-auto mt-1"
            onClick={() => void navigate(`/#${camera}`)}
          >
            {t("syncedPlayback.gap.goLive")}
          </Button>
        </>
      ) : (
        <>
          <LuVideoOff className="size-6 text-muted-foreground" />
          <div className="text-sm font-medium text-primary">
            {t("syncedPlayback.gap.title")}
          </div>
          <div className="text-xs text-muted-foreground">
            {nextStart === undefined
              ? t("syncedPlayback.gap.noneLater")
              : t("syncedPlayback.gap.next", { time: format(nextStart) })}
          </div>
        </>
      )}
    </div>
  );
}

function SyncedClockReadout({
  config,
  time,
  syncing,
}: Readonly<{
  config: FrigateConfig | undefined;
  time: number;
  syncing: boolean;
}>) {
  const { t } = useTranslation(["fork"]);
  const format = useClockFormat(config);

  return (
    <div className="flex items-center gap-3 text-sm">
      <span
        data-testid="synced-playback-clock"
        className="font-mono tabular-nums text-primary"
      >
        {format(time)}
      </span>
      <span
        data-testid="synced-playback-status"
        data-syncing={syncing}
        className="flex items-center gap-1 text-xs text-muted-foreground"
      >
        {syncing ? (
          <ActivityIndicator className="w-auto" size={12} />
        ) : (
          <LuCheck className="size-3" />
        )}
        {syncing
          ? t("syncedPlayback.status.syncing")
          : t("syncedPlayback.status.inSync")}
      </span>
    </div>
  );
}

type SyncedCameraPickerProps = {
  cameras: readonly string[];
  tiles: readonly string[];
  mainCamera: string;
  max: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (camera: string, on: boolean) => void;
  /** Where the menu renders; the fullscreen element while fullscreen. */
  portal: HTMLElement | undefined;
};

function SyncedCameraPicker({
  cameras,
  tiles,
  mainCamera,
  max,
  open,
  onOpenChange,
  onToggle,
  portal,
}: Readonly<SyncedCameraPickerProps>) {
  const { t } = useTranslation(["fork"]);
  const full = tiles.length >= max;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="flex items-center gap-2"
          aria-label={t("syncedPlayback.picker.button")}
        >
          <LuLayoutGrid className="size-4" />
          {t("syncedPlayback.picker.count", { selected: tiles.length, max })}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-56"
        portalProps={{ container: portal }}
      >
        <DropdownMenuLabel>
          {t("syncedPlayback.picker.title")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {cameras.map((camera) => {
          const checked = tiles.includes(camera);

          return (
            <DropdownMenuCheckboxItem
              key={camera}
              checked={checked}
              disabled={camera == mainCamera || (!checked && full)}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(on) => onToggle(camera, on)}
            >
              <CameraNameLabel
                className="cursor-pointer smart-capitalize"
                camera={camera}
              />
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <div className="px-2 py-1 text-xs text-muted-foreground">
          {t("syncedPlayback.picker.limit", { max })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The content size of `element`, kept current. */
function useElementSize(element: HTMLElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const { contentRect } of entries) {
        const { width, height } = contentRect;
        setSize((prev) =>
          prev.width == width && prev.height == height
            ? prev
            : { width, height },
        );
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return size;
}

/**
 * Element fullscreen for one tile or the whole grid. The view's own
 * fullscreen hook listens for F11 on every instance, so the grid keeps a
 * single small one.
 */
function useElementFullscreen() {
  const [element, setElement] = useState<Element | null>(null);

  useEffect(() => {
    const onChange = () => setElement(document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = useCallback((target: HTMLElement | null) => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else if (target && typeof target.requestFullscreen === "function") {
      void target.requestFullscreen().catch(() => undefined);
    }
  }, []);

  return { element, toggle };
}
