import type { SectionConfigOverrides } from "./types";

const notifications: SectionConfigOverrides = {
  base: {
    sectionDocs: "/configuration/notifications",
    restartRequired: [],
    fieldOrder: ["enabled", "email"],
    fieldGroups: {},
    hiddenFields: ["enabled_in_config"],
    advancedFields: [],
    // fork (D78): schedule editor in place of the plain list of windows
    uiSchema: {
      quiet_hours: {
        "ui:field": "QuietHoursField",
        "ui:options": { label: false, suppressDescription: true },
      },
    },
    fieldMessages: [
      {
        key: "profile-base-notifications-disabled",
        field: "enabled",
        messageKey: "configMessages.notifications.profileBaseDisabled",
        severity: "warning",
        position: "after",
        condition: (ctx) =>
          !!ctx.profileName &&
          ctx.formData?.enabled === true &&
          !Object.values(ctx.fullConfig.cameras).some(
            (camera) =>
              camera.enabled_in_config &&
              camera.notifications.enabled_in_config,
          ),
      },
    ],
  },
  global: {
    uiSchema: {
      "ui:before": { render: "NotificationsSettingsExtras" },
      enabled: { "ui:widget": "hidden" },
      email: { "ui:widget": "hidden" },
      cooldown: { "ui:widget": "hidden" },
      enabled_in_config: { "ui:widget": "hidden" },
    },
  },
  camera: {
    hiddenFields: ["enabled_in_config", "email"],
  },
};

export default notifications;
