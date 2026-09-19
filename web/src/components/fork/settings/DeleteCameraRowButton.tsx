/**
 * Fork: a camera row's delete action on Camera management (UI111).
 *
 * "Delete Camera" was a full-weight red button beside "Add New Camera". It
 * is now a quiet icon button on each row; the existing DeleteCameraDialog
 * still asks for confirmation before anything is removed.
 */

import { useTranslation } from "react-i18next";
import { LuTrash2 } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { useCameraFriendlyName } from "@/hooks/use-camera-friendly-name";

type DeleteCameraRowButtonProps = {
  camera: string;
  onDelete: (camera: string) => void;
};

export default function DeleteCameraRowButton({
  camera,
  onDelete,
}: Readonly<DeleteCameraRowButtonProps>) {
  const { t } = useTranslation(["fork"]);
  const name = useCameraFriendlyName(camera);
  const label = t("cameraTable.delete", { camera: name });

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      aria-label={label}
      title={label}
      data-testid="camera-row-delete"
      onClick={() => onDelete(camera)}
    >
      <LuTrash2 className="size-4" aria-hidden />
    </Button>
  );
}
