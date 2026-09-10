import CommandPaletteHint from "@/components/fork/CommandPaletteHint";
import InboxBell from "@/components/fork/InboxBell";
import type { ForkNavVariant } from "@/components/fork/ForkNavButton";
import { isForkEnabled } from "@/fork/flags";

type ForkNavItemsProps = {
  variant: ForkNavVariant;
  large?: boolean;
};

/**
 * Single mount point for fork navigation entries so the upstream Sidebar and
 * Bottombar each only need a one-line hunk.
 */
export default function ForkNavItems({ variant, large }: ForkNavItemsProps) {
  return (
    <>
      {isForkEnabled("commandPalette") && (
        <CommandPaletteHint variant={variant} large={large} />
      )}
      {isForkEnabled("notificationInbox") && (
        <InboxBell variant={variant} large={large} />
      )}
    </>
  );
}
