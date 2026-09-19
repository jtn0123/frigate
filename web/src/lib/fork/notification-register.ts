/**
 * Fork: why "Register This Device" is disabled (UI114).
 *
 * The Notifications page disables the button until notifications are on in
 * the saved config, at least one camera is selected and Frigate's push key
 * has loaded (`NotificationsSettingsExtras`). This names the first of those
 * that is missing so the page can say it under the button.
 */

export type RegisterBlocker =
  "noCameras" | "notSaved" | "keyLoading" | "keyUnavailable";

type RegisterState = {
  /** At least one camera selected in the form ("All cameras" counts). */
  camerasSelected: boolean;
  /** Notifications are on in the saved config, globally or per camera. */
  enabledInConfig: boolean;
  /** The push key has loaded. */
  hasKey: boolean;
  /** The push key request failed. */
  keyError: boolean;
};

export function registerBlocker({
  camerasSelected,
  enabledInConfig,
  hasKey,
  keyError,
}: RegisterState): RegisterBlocker | null {
  if (!camerasSelected) {
    return "noCameras";
  }
  if (!enabledInConfig) {
    return "notSaved";
  }
  if (hasKey) {
    return null;
  }
  return keyError ? "keyUnavailable" : "keyLoading";
}
