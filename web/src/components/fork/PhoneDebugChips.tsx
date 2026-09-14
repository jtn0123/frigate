/**
 * One-tap Debug View overlays under the frame on portrait phones (fork, flag
 * `phoneFixes`).
 *
 * A 16:9 camera frame is only about 230 px tall at phone width, so the rest
 * of the portrait screen is free. Instead of leaving it empty, the overlays
 * sit right under the frame as a grid of toggle chips, so turning boxes,
 * zones or motion on and off never hides the frame. "All options" opens the
 * full panel (descriptions, object list) in the bottom sheet.
 */

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

type DebugOverlay = { param: string; title: string };

type PhoneDebugChipsProps = {
  overlays: DebugOverlay[];
  options: Record<string, boolean> | undefined;
  onToggle: (param: string, value: boolean) => void;
  onAllOptions: () => void;
  className?: string;
};

export default function PhoneDebugChips({
  overlays,
  options,
  onToggle,
  onAllOptions,
  className,
}: Readonly<PhoneDebugChipsProps>) {
  const { t } = useTranslation(["fork"]);

  return (
    <section
      data-testid="phone-debug-chips"
      aria-label={t("phoneDebug.overlays")}
      className={cn("mt-3 px-1", className)}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("phoneDebug.overlays")}
        </h3>
        <button
          type="button"
          onClick={onAllOptions}
          className="rounded-md px-2 py-1 text-sm font-medium text-selected active:bg-selected/10"
        >
          {t("phoneDebug.allOptions")}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {overlays.map(({ param, title }) => {
          const on = options?.[param] === true;
          return (
            <button
              key={param}
              type="button"
              role="switch"
              aria-checked={on}
              onClick={() => onToggle(param, !on)}
              className={cn(
                "flex h-11 items-center justify-between gap-2 rounded-xl px-3 text-left text-sm font-medium transition-colors duration-200 active:scale-[0.98]",
                on
                  ? "bg-selected/15 text-primary ring-1 ring-selected/50"
                  : "bg-secondary text-secondary-foreground",
              )}
            >
              <span className="truncate">{title}</span>
              <span
                aria-hidden="true"
                className={cn(
                  "size-2.5 shrink-0 rounded-full transition-all duration-200",
                  on
                    ? "bg-selected ring-4 ring-selected/20"
                    : "bg-muted-foreground/40",
                )}
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}
