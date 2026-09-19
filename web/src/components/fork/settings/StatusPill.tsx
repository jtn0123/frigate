/**
 * Fork: a neutral on/off status pill for settings pages (UI113).
 *
 * Frigate+ marked every camera without snapshots, and a missing API key,
 * with a red X, as if something had failed. A state that is simply off
 * reads as a gray pill; an active one gets a green dot.
 */

import { cn } from "@/lib/utils";

type StatusPillProps = {
  active: boolean;
  label: string;
  className?: string;
};

export default function StatusPill({
  active,
  label,
  className,
}: Readonly<StatusPillProps>) {
  return (
    <span
      data-testid="status-pill"
      data-active={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-secondary-highlight bg-secondary px-2.5 py-0.5 text-xs font-medium",
        active ? "text-primary" : "text-primary-variant",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          active ? "bg-success" : "bg-muted-foreground",
        )}
      />
      {label}
    </span>
  );
}
