/**
 * Fork: the reason under a disabled "Register This Device" button (UI114).
 */

import { useTranslation } from "react-i18next";
import type { RegisterBlocker } from "@/lib/fork/notification-register";

type RegisterDeviceHintProps = {
  blocker: RegisterBlocker | null;
};

export default function RegisterDeviceHint({
  blocker,
}: Readonly<RegisterDeviceHintProps>) {
  const { t } = useTranslation(["fork"]);

  let message: string;
  switch (blocker) {
    case null:
      return null;
    case "noCameras":
      message = t("registerDevice.noCameras");
      break;
    case "notSaved":
      message = t("registerDevice.notSaved");
      break;
    case "keyLoading":
      message = t("registerDevice.keyLoading");
      break;
    case "keyUnavailable":
      message = t("registerDevice.keyUnavailable");
      break;
  }

  return (
    <p
      className="text-sm text-muted-foreground"
      data-testid="register-device-hint"
      data-blocker={blocker}
    >
      {message}
    </p>
  );
}
