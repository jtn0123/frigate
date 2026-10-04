/**
 * Wall display controls (UI19): a small bar that appears on activity and
 * fades with the cursor, a paused chip that stays while cycling is paused,
 * the exit hint, and the cycle progress line along the bottom edge.
 */

import { useTranslation } from "react-i18next";
import {
  LuChevronLeft,
  LuChevronRight,
  LuLogOut,
  LuMaximize,
  LuMinimize,
  LuPause,
  LuPlay,
} from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type KioskControlsProps = {
  visible: boolean;
  /** Name of the group (or selection) on screen. */
  sourceLabel: string;
  index: number;
  count: number;
  /** The link asks for cycling and there is more than one slide. */
  cycles: boolean;
  paused: boolean;
  /** An alert has the screen; its banner takes the paused chip's place. */
  alerting: boolean;
  /** Countdown running: draw the progress line. */
  running: boolean;
  cycleSeconds: number;
  epoch: number;
  exitHint: boolean;
  fullscreen: boolean;
  supportsFullscreen: boolean;
  onStep: (delta: number) => void;
  onTogglePaused: () => void;
  onToggleFullscreen: () => void;
  onExit: () => void;
};

const controlClass =
  "size-10 rounded-full text-white hover:bg-white/15 hover:text-white";

export default function KioskControls({
  visible,
  sourceLabel,
  index,
  count,
  cycles,
  paused,
  alerting,
  running,
  cycleSeconds,
  epoch,
  exitHint,
  fullscreen,
  supportsFullscreen,
  onStep,
  onTogglePaused,
  onToggleFullscreen,
  onExit,
}: Readonly<KioskControlsProps>) {
  const { t } = useTranslation(["fork"]);

  return (
    <>
      {cycles && paused && !alerting && (
        <div
          className="pointer-events-none absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-sm text-white"
          data-testid="kiosk-paused"
        >
          <LuPause aria-hidden className="size-4" />
          {t("kiosk.controls.paused")}
        </div>
      )}

      {exitHint && (
        <output
          className="pointer-events-none absolute bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-sm text-white shadow-lg"
          data-testid="kiosk-exit-hint"
        >
          {t("kiosk.controls.exitHint")}
        </output>
      )}

      <div
        role="toolbar"
        aria-label={t("kiosk.controls.label")}
        data-testid="kiosk-controls"
        data-visible={visible}
        className={cn(
          // w-max: sized to its content, not squeezed into the half
          // screen right of left-1/2; the name truncates on a phone
          "absolute bottom-5 left-1/2 z-50 flex w-max max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1 rounded-full bg-black/70 px-2 py-1.5 text-white shadow-xl backdrop-blur transition-opacity duration-300",
          visible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {count > 1 && (
          <Button
            variant="ghost"
            size="icon"
            className={controlClass}
            aria-label={t("kiosk.controls.previous")}
            onClick={() => onStep(-1)}
          >
            <LuChevronLeft className="size-5" />
          </Button>
        )}
        {cycles && (
          <Button
            variant="ghost"
            size="icon"
            className={controlClass}
            aria-label={
              paused ? t("kiosk.controls.resume") : t("kiosk.controls.pause")
            }
            aria-pressed={paused}
            onClick={onTogglePaused}
          >
            {paused ? (
              <LuPlay className="size-5" />
            ) : (
              <LuPause className="size-5" />
            )}
          </Button>
        )}
        {count > 1 && (
          <Button
            variant="ghost"
            size="icon"
            className={controlClass}
            aria-label={t("kiosk.controls.next")}
            onClick={() => onStep(1)}
          >
            <LuChevronRight className="size-5" />
          </Button>
        )}
        <div className="flex min-w-0 items-baseline gap-2 px-3">
          <span className="max-w-56 truncate text-sm font-medium smart-capitalize">
            {sourceLabel}
          </span>
          {count > 1 && (
            <span
              className="shrink-0 whitespace-nowrap text-xs tabular-nums text-white/70"
              data-testid="kiosk-position"
            >
              {t("kiosk.controls.position", {
                current: index + 1,
                total: count,
              })}
            </span>
          )}
        </div>
        {supportsFullscreen && (
          <Button
            variant="ghost"
            size="icon"
            className={controlClass}
            aria-label={
              fullscreen
                ? t("button.exitFullscreen", { ns: "common" })
                : t("button.fullscreen", { ns: "common" })
            }
            onClick={onToggleFullscreen}
          >
            {fullscreen ? (
              <LuMinimize className="size-5" />
            ) : (
              <LuMaximize className="size-5" />
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={controlClass}
          aria-label={t("kiosk.controls.exit")}
          onClick={onExit}
        >
          <LuLogOut className="size-5" />
        </Button>
      </div>

      {running && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-1">
          <div
            key={`${index}-${epoch}`}
            className="fork-kiosk-bar h-full bg-white/50"
            data-testid="kiosk-progress"
            style={{ animationDuration: `${cycleSeconds}s` }}
          />
        </div>
      )}
    </>
  );
}
