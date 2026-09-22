import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LuCheck, LuLink } from "react-icons/lu";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export default function ShareViewButton({
  compact = false,
}: Readonly<{ compact?: boolean }>) {
  const { t } = useTranslation("fork");
  const location = useLocation();
  const [copiedKey, setCopiedKey] = useState<string>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedKey(location.key);
    } catch {
      window.prompt(t("navigation.copyFailed"), window.location.href);
    }
  };
  return (
    <Button
      variant={compact ? "ghost" : "outline"}
      size={compact ? "icon" : "sm"}
      className={cn(
        "h-auto min-h-9 min-w-0 whitespace-normal py-2 text-left",
        compact && "size-11 shrink-0 p-0",
      )}
      onClick={() => {
        void copy();
      }}
    >
      {compact && copiedKey === location.key ? (
        <LuCheck className="size-4 shrink-0" />
      ) : (
        <LuLink className={cn("size-4 shrink-0", !compact && "mr-2")} />
      )}
      <span className={compact ? "sr-only" : undefined}>
        {t(
          copiedKey === location.key
            ? "navigation.copied"
            : "navigation.copyView",
        )}
      </span>
    </Button>
  );
}
