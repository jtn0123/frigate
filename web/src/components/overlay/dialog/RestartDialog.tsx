import { useState, useEffect } from "react";
import { wrapAsync } from "@/utils/promise";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { baseUrl } from "@/api/baseUrl";

import { useTranslation } from "react-i18next";

type RestartDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  /** Resolve to false to cancel, e.g. when a save that must precede the
   * restart fails; the restarting sheet then never opens. */
  onRestart: () => void | Promise<boolean | void>;
};

export default function RestartDialog({
  isOpen,
  onClose,
  onRestart,
}: Readonly<RestartDialogProps>) {
  const { t } = useTranslation("components/dialog");
  const [restartDialogOpen, setRestartDialogOpen] = useState(isOpen);
  const [restartingSheetOpen, setRestartingSheetOpen] = useState(false);
  const [countdown, setCountdown] = useState(60);

  useEffect(() => {
    setRestartDialogOpen(isOpen);
  }, [isOpen]);

  useEffect(() => {
    let countdownInterval: NodeJS.Timeout;

    if (restartingSheetOpen) {
      countdownInterval = setInterval(() => {
        setCountdown((prevCountdown) => prevCountdown - 1);
      }, 1000);
    }

    return () => {
      clearInterval(countdownInterval);
    };
  }, [restartingSheetOpen]);

  useEffect(() => {
    if (countdown === 0) {
      window.location.href = baseUrl;
    }
  }, [countdown]);

  const handleRestart = async () => {
    const result = await onRestart();
    if (result === false) {
      setRestartDialogOpen(false);
      onClose();
      return;
    }
    setRestartingSheetOpen(true);
  };

  const handleForceReload = () => {
    window.location.href = baseUrl;
  };

  return (
    <>
      <AlertDialog
        open={restartDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setRestartDialogOpen(false);
            onClose();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("restart.title")}</AlertDialogTitle>
            <AlertDialogDescription className="sr-only">
              {t("restart.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("button.cancel", { ns: "common" })}
            </AlertDialogCancel>
            <AlertDialogAction onClick={wrapAsync(handleRestart)}>
              {t("restart.button")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet
        open={restartingSheetOpen}
        onOpenChange={() => setRestartingSheetOpen(false)}
      >
        <SheetContent
          side="top"
          onInteractOutside={(e) => e.preventDefault()}
          className="[&>button:first-of-type]:hidden"
        >
          <div className="flex flex-col items-center">
            <ActivityIndicator />
            <SheetHeader className="mt-5 text-center">
              <SheetTitle className="text-center">
                {t("restart.restarting.title")}
              </SheetTitle>
              <SheetDescription className="text-center">
                <div>
                  {t("restart.restarting.content", {
                    countdown,
                  })}
                </div>
              </SheetDescription>
            </SheetHeader>
            <Button
              size="lg"
              className="mt-5"
              aria-label={t("restart.restarting.button")}
              onClick={handleForceReload}
            >
              {t("restart.restarting.button")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
