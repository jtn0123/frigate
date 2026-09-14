/**
 * Overlays pill and backdrop for the phone Debug View sheet (fork, flag
 * `phoneFixes`).
 *
 * The pill floats over the bottom-right of the camera frame in the same
 * frosted style as the fullscreen controls, and counts the overlays that
 * are on, so what the frame is showing is readable without opening the
 * sheet. The backdrop dims the frame while the sheet is open; tapping it,
 * or the system back gesture, closes the sheet.
 */

import { useTranslation } from "react-i18next";
import { LuSlidersHorizontal } from "react-icons/lu";
import { cn } from "@/lib/utils";

type PhoneDebugSheetControlsProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeCount: number;
};

export default function PhoneDebugSheetControls({
  open,
  onOpenChange,
  activeCount,
}: Readonly<PhoneDebugSheetControlsProps>) {
  const { t } = useTranslation(["fork"]);

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden={!open}
        aria-label={t("phoneDebug.close")}
        onClick={() => onOpenChange(false)}
        className={cn(
          "fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] transition-opacity duration-300",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <button
        type="button"
        data-testid="phone-debug-overlays"
        aria-expanded={open}
        onClick={() => onOpenChange(true)}
        className={cn(
          "fixed bottom-[calc(3.75rem+env(safe-area-inset-bottom))] right-3 z-30 flex h-10 items-center gap-2 rounded-full bg-black/60 pl-3.5 pr-1.5 text-sm font-medium text-white shadow-lg ring-1 ring-white/15 backdrop-blur-md transition-all duration-300 active:scale-95",
          // Portrait has the overlay chips under the frame instead
          "portrait:hidden",
          open && "pointer-events-none translate-y-2 opacity-0",
        )}
      >
        <LuSlidersHorizontal className="size-4" />
        {t("phoneDebug.overlays")}
        <span
          className={cn(
            "flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-xs font-semibold tabular-nums",
            activeCount > 0 ? "bg-selected text-white" : "bg-white/15",
          )}
        >
          {activeCount}
        </span>
      </button>
    </>
  );
}
