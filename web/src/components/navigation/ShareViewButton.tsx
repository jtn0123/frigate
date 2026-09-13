import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LuLink } from "react-icons/lu";
import { Button } from "@/components/ui/button";

export default function ShareViewButton() {
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
      variant="outline"
      size="sm"
      onClick={() => {
        void copy();
      }}
    >
      <LuLink className="mr-2 size-4" />
      {t(
        copiedKey === location.key
          ? "navigation.copied"
          : "navigation.copyView",
      )}
    </Button>
  );
}
