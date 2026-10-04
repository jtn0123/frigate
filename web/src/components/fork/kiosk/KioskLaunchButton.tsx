/**
 * "Open as wall display" on Live (UI19, flag `kioskMode`): a button in the
 * camera group rail (desktop) or the Live header (phone) that opens the
 * wall display setup dialog.
 */

import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuMonitorPlay } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TooltipPortal } from "@radix-ui/react-tooltip";
import { isForkEnabled } from "@/fork/flags";
import { cn } from "@/lib/utils";

// The dialog's form controls are only needed once someone opens it.
const KioskSetupDialog = lazy(
  () => import("@/components/fork/kiosk/KioskSetupDialog"),
);

type KioskLaunchButtonProps = {
  variant: "rail" | "header";
  currentGroup?: string | undefined;
  className?: string;
};

export default function KioskLaunchButton({
  variant,
  currentGroup,
  className,
}: Readonly<KioskLaunchButtonProps>) {
  const { t } = useTranslation(["fork"]);
  const [open, setOpen] = useState(false);
  // stays mounted after the first open so the dialog can animate closed
  const [loaded, setLoaded] = useState(false);

  if (!isForkEnabled("kioskMode")) {
    return null;
  }

  const label = t("kiosk.launch");
  const button = (
    <Button
      className={cn(
        "bg-secondary text-secondary-foreground",
        variant === "rail" && "focus:bg-secondary",
        className,
      )}
      size={variant === "rail" ? "xs" : "sm"}
      aria-label={label}
      data-testid="kiosk-launch"
      onClick={() => {
        setLoaded(true);
        setOpen(true);
      }}
    >
      <LuMonitorPlay className={variant === "rail" ? "size-4" : "size-5"} />
    </Button>
  );

  return (
    <>
      {variant === "rail" ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipPortal>
            <TooltipContent side="right">{label}</TooltipContent>
          </TooltipPortal>
        </Tooltip>
      ) : (
        button
      )}
      {loaded && (
        <Suspense fallback={null}>
          <KioskSetupDialog
            open={open}
            onOpenChange={setOpen}
            currentGroup={currentGroup}
          />
        </Suspense>
      )}
    </>
  );
}
