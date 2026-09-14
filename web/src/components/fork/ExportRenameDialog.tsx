import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { usePendingAction } from "@/hooks/fork/use-pending-action";
import { useUnsavedNavigation } from "@/hooks/use-unsaved-navigation";

type Props = {
  id: string;
  name: string;
  onClose: () => void;
  onRename: (id: string, name: string) => Promise<void>;
};
export default function ExportRenameDialog({
  id,
  name,
  onClose,
  onRename,
}: Readonly<Props>) {
  const { t } = useTranslation(["views/exports", "fork", "common"]);
  const [value, setValue] = useState(name);
  const { pending, failed, run } = usePendingAction();
  useUnsavedNavigation(value !== name || pending);
  const save = () => {
    if (!value.trim() || value === name) return;
    void run(() => onRename(id, value.trim())).then((saved) => {
      if (saved) onClose();
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        aria-busy={pending}
        className={pending ? "[&>button]:hidden" : undefined}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogTitle>{t("editExport.title")}</DialogTitle>
        <DialogDescription>{t("editExport.desc")}</DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Input
            aria-label={t("editExport.title")}
            value={value}
            disabled={pending}
            onChange={(event) => setValue(event.target.value)}
          />
          {failed && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {t("navigation.renameFailed", { ns: "fork" })}
            </p>
          )}
          <DialogFooter className="mt-4">
            <Button
              type="submit"
              variant="select"
              aria-label={t("editExport.saveExport")}
              disabled={pending || !value.trim() || value.trim() === name}
            >
              {pending
                ? t("navigation.saving", { ns: "fork" })
                : t("button.save", { ns: "common" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
