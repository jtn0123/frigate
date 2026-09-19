/**
 * Timeline / Events / Detail on portrait phones (fork, flag `phoneFixes`).
 *
 * Desktop shows the three recording timelines as a toggle group in the
 * header. Phones only had an unlabeled icon that opened a drawer, so the
 * Detail timeline (with detection boxes on the video) was easy to miss.
 * This segmented control sits between the video and the timeline, with a
 * highlight that slides to the active mode. Landscape keeps the drawer:
 * its timeline column is too narrow for three labels.
 */

import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import type { IconType } from "react-icons";
import { LuChartNoAxesGantt, LuListVideo, LuScanSearch } from "react-icons/lu";
import { cn } from "@/lib/utils";
import type { TimelineType } from "@/types/timeline";

const MODES: { value: TimelineType; label: string; Icon: IconType }[] = [
  { value: "timeline", label: "timeline.label", Icon: LuChartNoAxesGantt },
  { value: "events", label: "events.label", Icon: LuListVideo },
  { value: "detail", label: "detail.label", Icon: LuScanSearch },
];

type PhoneTimelineTabsProps = {
  value: TimelineType;
  onValueChange: (value: TimelineType) => void;
  className?: string;
};

export default function PhoneTimelineTabs({
  value,
  onValueChange,
  className,
}: Readonly<PhoneTimelineTabsProps>) {
  const { t } = useTranslation(["views/events"]);
  const reducedMotion = useReducedMotion();

  return (
    <div
      role="radiogroup"
      aria-label={t("timeline.aria")}
      data-testid="phone-timeline-tabs"
      className={cn(
        "mx-2 grid shrink-0 grid-cols-3 gap-1 rounded-xl bg-secondary p-1",
        className,
      )}
    >
      {MODES.map(({ value: mode, label, Icon }) => {
        const active = mode === value;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onValueChange(mode)}
            className={cn(
              "relative flex h-11 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors duration-200 smart-capitalize",
              active
                ? "text-primary"
                : "text-muted-foreground active:text-primary",
            )}
          >
            {active && (
              <motion.span
                layoutId="phone-timeline-tab"
                aria-hidden="true"
                className="absolute inset-0 rounded-lg bg-background shadow-sm ring-1 ring-border/70"
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 520, damping: 40 }
                }
              />
            )}
            <Icon
              className={cn(
                "relative size-4 transition-colors",
                active && mode === "detail" && "text-selected",
              )}
            />
            <span className="relative">{t(label)}</span>
          </button>
        );
      })}
    </div>
  );
}
