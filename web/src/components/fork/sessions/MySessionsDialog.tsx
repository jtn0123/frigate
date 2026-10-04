/**
 * Fork (E26): the signed-in user's own sessions, opened from the account
 * menu, with "Sign out other sessions".
 *
 * Results show inside the dialog, not as toasts: the menu opens on any page,
 * and a page's Toaster sat under this dialog's overlay (the live dashboard)
 * or was not mounted at all.
 */

import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import SessionsPanel from "./SessionsPanel";

type MySessionsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  username: string | undefined;
};

export default function MySessionsDialog({
  open,
  onOpenChange,
  username,
}: Readonly<MySessionsDialogProps>) {
  const { t } = useTranslation(["fork"]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-[520px]"
        data-testid="my-sessions-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("sessions.myTitle")}</DialogTitle>
          <DialogDescription>{t("sessions.myDescription")}</DialogDescription>
        </DialogHeader>
        {/* read only while open: the list polls */}
        {open && username && <SessionsPanel user={username} inlineFeedback />}
      </DialogContent>
    </Dialog>
  );
}
