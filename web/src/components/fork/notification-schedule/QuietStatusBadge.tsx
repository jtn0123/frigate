/** Fork (D78): whether push notifications are held back right now. */

import { useTranslation } from "react-i18next";
import { LuBell, LuBellOff, LuMoon } from "react-icons/lu";

import { cn } from "@/lib/utils";

export type QuietState = "quiet" | "notifying" | "off";

const STYLES: Record<QuietState, string> = {
  quiet:
    "border-indigo-500/30 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  notifying:
    "border-green-500/30 bg-green-500/15 text-green-700 dark:text-green-300",
  off: "border-border bg-muted text-muted-foreground",
};

type QuietStatusBadgeProps = {
  state: QuietState;
  testId?: string;
  className?: string;
};

export function QuietStatusBadge({
  state,
  testId,
  className,
}: Readonly<QuietStatusBadgeProps>) {
  const { t } = useTranslation(["fork"]);
  const Icon =
    state === "quiet" ? LuMoon : state === "off" ? LuBellOff : LuBell;
  let label: string;
  switch (state) {
    case "quiet":
      label = t("notificationSchedule.status.quiet");
      break;
    case "notifying":
      label = t("notificationSchedule.status.notifying");
      break;
    case "off":
      label = t("notificationSchedule.status.off");
      break;
  }
  return (
    <span
      data-testid={testId}
      data-state={state}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium",
        STYLES[state],
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );
}
