import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/** Keep the camera restriction visible and removable after leaving Health. */
export default function CameraLogFilter({
  camera,
  onClear,
}: Readonly<{
  camera: string;
  onClear: () => void;
}>) {
  const { t } = useTranslation("fork");
  return (
    <div
      className="flex flex-wrap items-center gap-3 pt-2 text-sm"
      data-testid="camera-log-filter"
    >
      <span>{t("cameraHealth.logs.filtered", { camera })}</span>
      <Button size="sm" variant="ghost" onClick={onClear}>
        {t("cameraHealth.logs.clear")}
      </Button>
    </div>
  );
}
