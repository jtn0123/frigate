/**
 * One-tap detection boxes on the phone camera page (fork, flag
 * `phoneFixes`).
 *
 * Desktop reaches Debug View (the live frame with bounding boxes drawn by
 * Frigate) from the camera's gear menu. On phones it was the last switch in
 * a long settings drawer. This header toggle turns it on and off in one
 * tap; it lights up in the selected color while boxes are showing.
 */

import { useTranslation } from "react-i18next";
import { isMobileOnly } from "react-device-detect";
import { LuScanSearch } from "react-icons/lu";
import CameraFeatureToggle from "@/components/dynamic/CameraFeatureToggle";
import { phoneFixes } from "@/lib/fork/phone";
import { cn } from "@/lib/utils";

type PhoneBoxesToggleProps = {
  debug: boolean;
  setDebug: (debug: boolean) => void;
};

export default function PhoneBoxesToggle({
  debug,
  setDebug,
}: Readonly<PhoneBoxesToggleProps>) {
  const { t } = useTranslation(["fork"]);

  if (!phoneFixes || !isMobileOnly) {
    return null;
  }

  return (
    <CameraFeatureToggle
      className={cn(
        "p-2 transition-shadow duration-300",
        debug && "ring-4 ring-selected/25",
      )}
      variant="primary"
      Icon={LuScanSearch}
      isActive={debug}
      title={debug ? t("phoneDebug.hideBoxes") : t("phoneDebug.showBoxes")}
      onClick={() => setDebug(!debug)}
    />
  );
}
