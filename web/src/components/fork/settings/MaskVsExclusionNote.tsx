/**
 * Fork (D77): tells an object mask apart from an exclusion zone where object
 * masks are explained, since the two are easy to confuse and a mask breaks
 * tracks that an exclusion zone keeps.
 */

import { useTranslation } from "react-i18next";
import { isForkEnabled } from "@/fork/flags";

export default function MaskVsExclusionNote({
  className,
}: Readonly<{ className?: string }>) {
  const { t } = useTranslation(["fork"]);

  if (!isForkEnabled("lineZones")) return null;

  return (
    <p className={className} data-testid="mask-vs-exclusion">
      {t("lineZones.maskVsExclusion")}
    </p>
  );
}
