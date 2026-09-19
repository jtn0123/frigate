import type { SectionConfigOverrides } from "./types";

const birdseye: SectionConfigOverrides = {
  base: {
    sectionDocs: "/configuration/birdseye",
    messages: [
      {
        key: "objects-mode-detect-disabled",
        messageKey: "configMessages.birdseye.objectsModeDetectDisabled",
        // fork (UI117): the camera silently never appears in Birdseye, so
        // this is a warning, and it links to the setting behind it
        severity: "warning",
        condition: (ctx) => {
          if (ctx.level !== "camera" || !ctx.fullCameraConfig) return false;
          return (
            ctx.formData?.mode === "objects" &&
            ctx.fullCameraConfig.detect?.enabled === false
          );
        },
        action: (ctx) =>
          ctx.cameraName
            ? {
                labelKey: "configMessages.birdseye.openDetectSettings",
                href: `/settings?page=cameraDetect&camera=${encodeURIComponent(
                  ctx.cameraName,
                )}`,
              }
            : undefined,
      },
    ],
    restartRequired: [],
    fieldOrder: ["enabled", "mode", "order"],
    hiddenFields: ["order"],
    advancedFields: [],
    overrideFields: ["enabled", "mode"],
    uiSchema: {
      mode: {
        "ui:size": "xs",
        "ui:options": {
          enumI18nPrefix: "birdseye.trackingMode",
        },
      },
    },
  },
  global: {
    fieldOrder: [
      "enabled",
      "restream",
      "width",
      "height",
      "quality",
      "mode",
      "layout",
      "inactivity_threshold",
      "idle_heartbeat_fps",
    ],
    advancedFields: ["width", "height", "quality", "inactivity_threshold"],
    restartRequired: [
      "enabled",
      "restream",
      "width",
      "height",
      "quality",
      "layout.scaling_factor",
      "idle_heartbeat_fps",
    ],
    uiSchema: {
      mode: {
        "ui:size": "xs",
        "ui:after": { render: "BirdseyeCameraReorder" },
      },
    },
  },
};

export default birdseye;
