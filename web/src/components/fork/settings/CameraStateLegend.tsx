/**
 * Fork: short legend under the camera state table (UI111).
 *
 * Replaces the long On / Off / Disabled paragraph beside the list. The
 * meanings follow `CameraStatusSelect` in CameraManagementView: Off sends
 * the runtime OFF command (lost on restart); Disabled also writes
 * `enabled: false` to the config, and turning it back on needs a restart.
 */

import { useTranslation } from "react-i18next";

export default function CameraStateLegend() {
  const { t } = useTranslation(["fork", "views/settings"]);

  const states = [
    {
      name: t("cameraManagement.streams.status.on", { ns: "views/settings" }),
      meaning: t("cameraStateLegend.on"),
    },
    {
      name: t("cameraManagement.streams.status.off", { ns: "views/settings" }),
      meaning: t("cameraStateLegend.off"),
    },
    {
      name: t("cameraManagement.streams.status.disabled", {
        ns: "views/settings",
      }),
      meaning: t("cameraStateLegend.disabled"),
    },
  ];

  return (
    <div
      data-testid="camera-state-legend"
      className="space-y-1.5 text-sm text-muted-foreground"
    >
      <ul className="flex flex-col gap-x-6 gap-y-1 lg:flex-row lg:flex-wrap">
        {states.map((state) => (
          <li key={state.name}>
            <span className="font-medium text-primary">{state.name}</span>{" "}
            {state.meaning}
          </li>
        ))}
      </ul>
      <p>{t("cameraStateLegend.notes")}</p>
    </div>
  );
}
