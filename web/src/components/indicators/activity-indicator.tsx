import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { AiOutlineLoading3Quarters } from "react-icons/ai";

export default function ActivityIndicator({ className = "w-full", size = 30 }) {
  const { t } = useTranslation(["fork"]);

  return (
    <div
      className={cn("flex items-center justify-center", className)}
      // fork: a label on a plain div is prohibited ARIA; a status is named
      role="status"
      aria-label={t("a11yLabels.loading", { ns: "fork" })}
    >
      <AiOutlineLoading3Quarters className="animate-spin" size={size} />
    </div>
  );
}
