/**
 * Fork (UI143): the recording view's switch between one camera and the
 * synced multi-camera grid, and the slot that swaps the player area.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isDesktop } from "react-device-detect";
import { LuLayoutGrid } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type SyncedPlaybackToggleProps = {
  active: boolean;
  /** The grid needs a second camera to show. */
  available: boolean;
  onToggle: (active: boolean) => void;
};

export default function SyncedPlaybackToggle({
  active,
  available,
  onToggle,
}: Readonly<SyncedPlaybackToggleProps>) {
  const { t } = useTranslation(["fork"]);

  if (!available && !active) {
    return null;
  }

  const label = active
    ? t("syncedPlayback.toggle.disable")
    : t("syncedPlayback.toggle.enable");

  return (
    <Button
      size="sm"
      data-testid="synced-playback-toggle"
      className={cn(
        "flex items-center gap-2 rounded-lg",
        active && "bg-selected text-selected-foreground hover:bg-selected/90",
      )}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={() => onToggle(!active)}
    >
      <LuLayoutGrid
        className={cn(
          "size-4",
          active ? "text-selected-foreground" : "text-secondary-foreground",
        )}
      />
      {isDesktop && t("syncedPlayback.toggle.label")}
    </Button>
  );
}

type SyncedPlaybackSlotProps = {
  active: boolean;
  grid: ReactNode;
  className?: string;
  children: ReactNode;
};

/** Renders the grid in place of the single player area while active. */
export function SyncedPlaybackSlot({
  active,
  grid,
  className,
  children,
}: Readonly<SyncedPlaybackSlotProps>) {
  return active ? grid : <div className={className}>{children}</div>;
}
