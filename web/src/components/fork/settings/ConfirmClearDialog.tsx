/**
 * Fork (UI123): confirmation for the UI settings "Clear All" buttons.
 *
 * Both buttons discard browser-local state that no server copy can
 * restore: every dragged camera layout, or every per-group streaming
 * choice. They fired on the first click, so a mis-tap cost work that
 * cannot be recovered. This asks first and names what is being cleared.
 */

import { useTranslation } from "react-i18next";
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

type ConfirmClearDialogProps = {
  /** The title of the thing being cleared, already translated. */
  title: string;
  /** One sentence naming what is lost, already translated. */
  description: string;
  /** Label of the confirming button, already translated. */
  action: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export default function ConfirmClearDialog({
  title,
  description,
  action,
  open,
  onOpenChange,
  onConfirm,
}: Readonly<ConfirmClearDialogProps>) {
  const { t } = useTranslation(["common"]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="confirm-clear-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("button.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
