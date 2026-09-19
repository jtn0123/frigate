import type { SectionConfigOverrides } from "./types";

const genai: SectionConfigOverrides = {
  base: {
    sectionDocs: "/configuration/genai/genai_config",
    advancedFields: ["*.base_url", "*.provider_options", "*.runtime_options"],
    hiddenFields: ["genai.enabled_in_config"],
    restartRequired: [],
    uiSchema: {
      // fork: forkEmptyState shows "No providers yet" while empty (UI105)
      "ui:options": {
        disableNestedCard: true,
        forkEmptyState: "genaiProviders",
      },
      "*": {
        "ui:options": {
          disableNestedCard: true,
          additionalPropertyKeyLabel:
            "configForm.additionalProperties.providerNameLabel",
          additionalPropertyKeyPlaceholder:
            "configForm.additionalProperties.providerNamePlaceholder",
          additionalPropertyKeyPattern: "^[a-zA-Z0-9_-]+$",
          preventKeyRename: true,
        },
        "ui:order": [
          "provider",
          "api_key",
          "base_url",
          "model",
          "provider_options",
          "runtime_options",
          "*",
        ],
      },
      "*.roles": {
        "ui:widget": "genaiRoles",
      },
      "*.api_key": {
        "ui:widget": "password",
        "ui:options": { size: "lg" },
      },
      "*.base_url": {
        "ui:options": { size: "lg" },
      },
      "*.model": {
        "ui:widget": "genaiModel",
        "ui:options": { size: "xs" },
      },
      "*.provider": {
        "ui:options": { size: "xs" },
      },
      "*.provider_options": {
        "ui:field": "DictAsYamlField",
      },
      "*.runtime_options": {
        "ui:field": "DictAsYamlField",
      },
    },
  },
};

export default genai;
