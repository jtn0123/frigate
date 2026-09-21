import { useTranslation } from "react-i18next";
import ActivityIndicator from "@/components/indicators/activity-indicator";

export default function PageLoading() {
  // fork: a route fallback that suspends on its own namespace has no boundary
  // left to catch it, and the e2e harness waits on the marker below to know a
  // navigation is past the fallback, so this one never suspends (D49).
  const { t } = useTranslation("fork", { useSuspense: false });
  return (
    <output
      data-testid="page-loading"
      className="flex size-full flex-col items-center justify-center gap-3"
    >
      <ActivityIndicator />
      <span className="text-sm text-muted-foreground">
        {t("navigation.loading")}
      </span>
    </output>
  );
}
