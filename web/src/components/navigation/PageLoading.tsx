import { useTranslation } from "react-i18next";
import ActivityIndicator from "@/components/indicators/activity-indicator";

export default function PageLoading() {
  const { t } = useTranslation("fork");
  return (
    <output className="flex size-full flex-col items-center justify-center gap-3">
      <ActivityIndicator />
      <span className="text-sm text-muted-foreground">
        {t("navigation.loading")}
      </span>
    </output>
  );
}
