/**
 * Wall display (UI19, flag `kioskMode`): `/kiosk` renders live cameras with
 * no sidebar, status bar or page chrome and cycles through the camera groups
 * (or grid pages, or single cameras) its link names. See `lib/fork/kiosk.ts`
 * for the query string.
 *
 * Keys: left and right step, space pauses or resumes cycling, f toggles
 * fullscreen, Esc dismisses the alert showing (alerts that start together
 * take turns), then shows an exit hint, then returns to Live. The controls
 * and the cursor hide after a few idle seconds.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import useSWR from "swr";
import { useWsMessageSubscribe } from "@/api/ws";
import KioskClock from "@/components/fork/kiosk/KioskClock";
import KioskControls from "@/components/fork/kiosk/KioskControls";
import KioskSlideView from "@/components/fork/kiosk/KioskSlideView";
import KioskTakeoverView from "@/components/fork/kiosk/KioskTakeoverView";
import "@/components/fork/kiosk/kiosk.css";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { Button } from "@/components/ui/button";
import { useKioskCycle } from "@/hooks/fork/use-kiosk-cycle";
import { useKioskIdle } from "@/hooks/fork/use-kiosk-idle";
import { useKioskKeepAlive } from "@/hooks/fork/use-kiosk-keep-alive";
import { useKioskLiveModes } from "@/hooks/fork/use-kiosk-live-modes";
import { useAllowedCameras } from "@/hooks/use-allowed-cameras";
import useKeyboardListener, {
  type KeyModifiers,
} from "@/hooks/use-keyboard-listener";
import {
  CUSTOM_SOURCE,
  DEFAULT_GROUP,
  TAKEOVER_MS,
  buildKioskSlides,
  dismissTakeover,
  keepAliveMs,
  parseKioskSearch,
  queueTakeover,
  resolveKioskSources,
  reviewFromPayload,
  takeoverFromReview,
  type KioskTakeoverQueue,
} from "@/lib/fork/kiosk";
import {
  exitPageFullscreen,
  isPageFullscreen,
  supportsPageFullscreen,
  togglePageFullscreen,
} from "@/lib/fork/kiosk-fullscreen";
import { cn } from "@/lib/utils";
import type { FrigateConfig } from "@/types/frigateConfig";
import { ScreenWakeLock } from "@/utils/screen-wake-lock";

/** Idle time before the controls and cursor hide. */
const IDLE_MS = 3000;
/** Allowance for the display's clock running ahead of Frigate's, in seconds. */
const CLOCK_SKEW_S = 5;
/** How long the exit hint waits for the second Esc. */
const EXIT_HINT_MS = 3000;

const KEYS = ["ArrowLeft", "ArrowRight", " ", "Escape", "f"];

export default function KioskPage() {
  const { t } = useTranslation(["fork"]);
  const location = useLocation();
  const navigate = useNavigate();
  const settings = useMemo(
    () => parseKioskSearch(location.search),
    [location.search],
  );

  const { data: config } = useSWR<FrigateConfig>("config");
  const allowedCameras = useAllowedCameras();
  const sources = useMemo(
    () => (config ? resolveKioskSources(config, settings, allowedCameras) : []),
    [config, settings, allowedCameras],
  );
  const slides = useMemo(
    () => buildKioskSlides(sources, settings.mode, settings.tiles),
    [sources, settings.mode, settings.tiles],
  );

  useKioskKeepAlive(keepAliveMs(config?.auth));

  // alert takeover

  const shownCameras = useMemo(
    () => new Set(sources.flatMap((source) => source.cameras)),
    [sources],
  );
  const seenReviews = useRef(new Set<string>());
  // Alerts that start together take turns; the first one is on screen.
  const [takeovers, setTakeovers] = useState<KioskTakeoverQueue>([]);
  const takeover = takeovers.at(0);
  // When the display opened, in seconds: alerts that started earlier and
  // only send updates now do not take over.
  const openedAt = useRef(Number.POSITIVE_INFINITY);
  useEffect(() => {
    openedAt.current = Date.now() / 1000 - CLOCK_SKEW_S;
  }, []);

  // Every message, not the topic's latest value: a new alert and its first
  // update can arrive together and must not collapse into one render. Only
  // messages that arrive while the display is open count.
  useWsMessageSubscribe((message) => {
    if (!settings.alerts || message.topic !== "reviews") return;
    const next = takeoverFromReview(
      reviewFromPayload(message.payload),
      shownCameras,
      seenReviews.current,
      openedAt.current,
    );
    if (!next) return;
    seenReviews.current.add(next.reviewId);
    setTakeovers((queue) => queueTakeover(queue, next));
  });

  // Keyed on the review id, so only the next alert reaching the screen
  // starts a new turn.
  const takeoverId = takeover?.reviewId;
  useEffect(() => {
    if (takeoverId === undefined) return;
    const timer = setTimeout(
      () => setTakeovers((queue) => dismissTakeover(queue, takeoverId)),
      TAKEOVER_MS,
    );
    return () => clearTimeout(timer);
  }, [takeoverId]);

  // cycling

  const cycle = useKioskCycle(
    slides.length,
    settings.cycle,
    takeover !== undefined,
  );
  const { step: stepCycle, togglePaused } = cycle;
  const slide = slides.at(cycle.index);
  const cycles = settings.cycle > 0 && slides.length > 1;

  // screen, visibility and fullscreen

  const [windowVisible, setWindowVisible] = useState(
    () => document.visibilityState === "visible",
  );
  useEffect(() => {
    const onChange = () =>
      setWindowVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // Slides remount on every visit; the fallbacks cameras needed outlive them.
  const { learnedModes, learnMode } = useKioskLiveModes();

  useEffect(() => {
    const wakeLock = new ScreenWakeLock();
    wakeLock.enable();
    return () => wakeLock.disable();
  }, []);

  const [fullscreen, setFullscreen] = useState(isPageFullscreen);
  useEffect(() => {
    const onChange = () => setFullscreen(isPageFullscreen());
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);
  const supportsFullscreen = useMemo(supportsPageFullscreen, []);

  useEffect(() => {
    document.title = t("kiosk.documentTitle");
  }, [t]);

  // controls

  const { active } = useKioskIdle(IDLE_MS);
  const [exitHint, setExitHint] = useState(false);

  useEffect(() => {
    if (!exitHint) return;
    const timer = setTimeout(() => setExitHint(false), EXIT_HINT_MS);
    return () => clearTimeout(timer);
  }, [exitHint]);

  const exit = useCallback(() => {
    void exitPageFullscreen();
    void navigate("/");
  }, [navigate]);

  // Stepping takes the screen back from every waiting alert too: the next
  // one would otherwise cover the slide that was just picked.
  const step = useCallback(
    (delta: number) => {
      setTakeovers([]);
      stepCycle(delta);
    },
    [stepCycle],
  );

  const onKey = useCallback(
    (key: string | null, modifiers: KeyModifiers) => {
      if (key === null || !modifiers.down || modifiers.ctrl) return false;
      switch (key) {
        case "ArrowLeft":
          step(-1);
          return true;
        case "ArrowRight":
          step(1);
          return true;
        case " ":
          if (!modifiers.repeat && cycles) togglePaused();
          return true;
        case "f":
          if (!modifiers.repeat) void togglePageFullscreen();
          return true;
        case "Escape":
          if (modifiers.repeat) return true;
          if (takeover) {
            // only the alert showing; the next one takes its turn
            const { reviewId } = takeover;
            setTakeovers((queue) => dismissTakeover(queue, reviewId));
          } else if (exitHint) {
            exit();
          } else {
            setExitHint(true);
          }
          return true;
        default:
          return false;
      }
    },
    [step, cycles, togglePaused, takeover, exitHint, exit],
  );
  // The shared listener re-subscribes in a passive effect, after paint, so a
  // key pressed just after an alert appears could reach the previous
  // handler. Keys go through a ref that is current before paint instead.
  const latestOnKey = useRef(onKey);
  useLayoutEffect(() => {
    latestOnKey.current = onKey;
  }, [onKey]);
  const handleKey = useCallback(
    (key: string | null, modifiers: KeyModifiers) =>
      latestOnKey.current(key, modifiers),
    [],
  );
  useKeyboardListener(KEYS, handleKey);

  const sourceLabel = (key: string | undefined) => {
    if (key === undefined) return "";
    if (key === DEFAULT_GROUP) return t("kiosk.allCameras");
    if (key === CUSTOM_SOURCE) return t("kiosk.selectedCameras");
    return key.replaceAll("_", " ");
  };

  // The takeover camera keeps the streaming settings of a group showing it.
  const takeoverSource = takeover
    ? (sources.find((source) => source.cameras.includes(takeover.camera))
        ?.key ?? DEFAULT_GROUP)
    : DEFAULT_GROUP;

  let stage: React.ReactNode;
  if (!config) {
    stage = (
      <ActivityIndicator className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />
    );
  } else if (!slide) {
    stage = (
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center"
        data-testid="kiosk-empty"
      >
        <h2 className="text-2xl font-semibold">{t("kiosk.empty.title")}</h2>
        <p className="max-w-md text-white/75">{t("kiosk.empty.description")}</p>
        <Button variant="select" onClick={exit}>
          {t("kiosk.empty.back")}
        </Button>
      </div>
    );
  } else {
    stage = (
      // isolate: the players' own layers must stay under the clock, the
      // controls and the alert takeover
      <div
        className="absolute inset-0 isolate"
        data-testid="kiosk-stage"
        data-slide={cycle.index}
        data-source={slide.source}
        data-mode={settings.mode}
      >
        {/* A takeover covers the whole screen, so the slide's players stop
            under it instead of decoding video nobody sees (and streaming the
            alerting camera twice). The cycle keeps its place and the slide
            starts again when the last alert ends. */}
        {!takeover && (
          <KioskSlideView
            key={`${cycle.index}-${slide.source}-${slide.page}`}
            slide={slide}
            single={settings.mode === "single"}
            savedLayout={settings.savedLayout}
            windowVisible={windowVisible}
            learnedModes={learnedModes}
            onLearnMode={learnMode}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "absolute inset-0 select-none overflow-hidden bg-black text-white",
        !active && "cursor-none",
      )}
      data-testid="kiosk"
      data-idle={!active}
    >
      <h1 className="sr-only">{t("kiosk.documentTitle")}</h1>
      {stage}
      {takeover && (
        <KioskTakeoverView
          takeover={takeover}
          source={takeoverSource}
          waiting={takeovers.length - 1}
          windowVisible={windowVisible}
          learnedModes={learnedModes}
          onLearnMode={learnMode}
        />
      )}
      {settings.clock && <KioskClock />}
      {slide && (
        <KioskControls
          visible={active}
          sourceLabel={sourceLabel(slide.source)}
          index={cycle.index}
          count={slides.length}
          cycles={cycles}
          paused={cycle.paused}
          alerting={takeover !== undefined}
          running={cycle.running}
          cycleSeconds={settings.cycle}
          epoch={cycle.epoch}
          exitHint={exitHint}
          fullscreen={fullscreen}
          supportsFullscreen={supportsFullscreen}
          onStep={step}
          onTogglePaused={togglePaused}
          onToggleFullscreen={() => void togglePageFullscreen()}
          onExit={exit}
        />
      )}
    </div>
  );
}
