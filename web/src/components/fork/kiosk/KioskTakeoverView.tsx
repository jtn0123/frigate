/**
 * Alert takeover for the wall display (UI19): the alerting camera fills the
 * screen with a banner naming it and what was seen, how many alerts wait for
 * their turn after it, and a bar counting down to the next alert or the
 * return to the cycle.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LuSiren } from "react-icons/lu";
import KioskSlideView from "@/components/fork/kiosk/KioskSlideView";
import { useCameraFriendlyName } from "@/hooks/use-camera-friendly-name";
import {
  TAKEOVER_MS,
  type KioskSlide,
  type KioskTakeover,
} from "@/lib/fork/kiosk";
import type { LivePlayerMode } from "@/types/live";
import { getTranslatedLabel } from "@/utils/i18n";
import { formatList } from "@/utils/stringUtil";

type KioskTakeoverViewProps = {
  takeover: KioskTakeover;
  /** Source the camera is shown under, for its streaming settings. */
  source: string;
  /** Alerts queued after this one. */
  waiting: number;
  windowVisible: boolean;
  learnedModes: Partial<Record<string, LivePlayerMode>>;
  onLearnMode: (camera: string, mode: LivePlayerMode) => void;
};

export default function KioskTakeoverView({
  takeover,
  source,
  waiting,
  windowVisible,
  learnedModes,
  onLearnMode,
}: Readonly<KioskTakeoverViewProps>) {
  const { t } = useTranslation(["fork"]);
  const name = useCameraFriendlyName(takeover.camera);
  const slide = useMemo<KioskSlide>(
    () => ({ source, cameras: [takeover.camera], page: 0, pages: 1 }),
    [source, takeover.camera],
  );
  const labels = formatList([
    ...takeover.subLabels,
    ...takeover.objects.map((label) => getTranslatedLabel(label)),
    ...takeover.audio.map((label) => getTranslatedLabel(label, "audio")),
  ]);

  return (
    <div
      className="absolute inset-0 z-20 bg-black"
      data-testid="kiosk-takeover"
      data-camera={takeover.camera}
    >
      <KioskSlideView
        slide={slide}
        single
        savedLayout={false}
        windowVisible={windowVisible}
        learnedModes={learnedModes}
        onLearnMode={onLearnMode}
        hideLabels
      />
      <div className="pointer-events-none absolute inset-0 z-40 border-[6px] border-severity_alert" />
      <div
        role="alert"
        className="pointer-events-none absolute left-1/2 top-3 z-40 flex max-w-[70%] -translate-x-1/2 items-center gap-3 rounded-xl bg-severity_alert/90 px-4 py-2 text-white shadow-lg"
      >
        <LuSiren aria-hidden className="size-8 shrink-0" />
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wider text-white/85">
            {t("kiosk.takeover.badge")}
          </div>
          <div
            className="truncate text-2xl font-semibold smart-capitalize"
            data-testid="kiosk-takeover-camera"
          >
            {name}
          </div>
          {labels && (
            <div
              className="truncate text-base text-white/90"
              data-testid="kiosk-takeover-labels"
            >
              {labels}
            </div>
          )}
        </div>
        {waiting > 0 && (
          <div
            className="shrink-0 self-center whitespace-nowrap rounded-full bg-black/35 px-3 py-1 text-sm font-semibold"
            data-testid="kiosk-takeover-more"
          >
            {t("kiosk.takeover.more", { count: waiting })}
          </div>
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 z-40 h-1.5 bg-white/10">
        <div
          key={takeover.reviewId}
          className="fork-kiosk-bar h-full bg-severity_alert"
          data-direction="down"
          style={{ animationDuration: `${TAKEOVER_MS}ms` }}
        />
      </div>
    </div>
  );
}
