import CommandPaletteHint from "@/components/fork/CommandPaletteHint";
import InboxBell from "@/components/fork/InboxBell";
import UpdateNotices from "@/components/fork/updates/UpdateNotices";
import type { ForkNavVariant } from "@/components/fork/ForkNavButton";
import { isForkEnabled } from "@/fork/flags";
import { paletteInSettingsMenu } from "@/lib/fork/phone";

type ForkNavItemsProps = {
  variant: ForkNavVariant;
  large?: boolean;
};

/**
 * Single mount point for fork navigation entries so the upstream Sidebar and
 * Bottombar each only need a one-line hunk.
 */
export default function ForkNavItems({
  variant,
  large = false,
}: Readonly<ForkNavItemsProps>) {
  return (
    <>
      {/* on a phone the palette opens from the Settings drawer, which frees
          a bar slot so the rest can be 48px touch targets */}
      {isForkEnabled("commandPalette") && !paletteInSettingsMenu && (
        <CommandPaletteHint variant={variant} large={large} />
      )}
      {isForkEnabled("notificationInbox") && (
        <InboxBell variant={variant} large={large} />
      )}
      {isForkEnabled("updateNotices") && (
        <UpdateNotices variant={variant} large={large} />
      )}
    </>
  );
}
