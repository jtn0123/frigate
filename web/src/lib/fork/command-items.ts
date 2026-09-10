/**
 * Static command palette data that mirrors upstream navigation structures.
 *
 * Settings sections are copied from the `settingsGroups` table in
 * `pages/Settings.tsx` so the palette can deep link with `?page=<key>`
 * without touching that file. Keep the two lists in sync when rebasing.
 */

export type SettingsSection = {
  /** `settingsGroups[].label`, translated via `views/settings:menu.<label>` */
  group: string;
  /** `SettingsType` key, translated via `views/settings:menu.<key>` */
  key: string;
};

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { group: "general", key: "uiSettings" },
  { group: "globalConfig", key: "profiles" },
  { group: "globalConfig", key: "cameraManagement" },
  { group: "globalConfig", key: "globalDetect" },
  { group: "globalConfig", key: "globalObjects" },
  { group: "globalConfig", key: "globalMotion" },
  { group: "globalConfig", key: "globalFfmpeg" },
  { group: "globalConfig", key: "globalRecording" },
  { group: "globalConfig", key: "globalSnapshots" },
  { group: "globalConfig", key: "globalReview" },
  { group: "globalConfig", key: "globalAudioEvents" },
  { group: "globalConfig", key: "globalLivePlayback" },
  { group: "globalConfig", key: "globalTimestampStyle" },
  { group: "cameras", key: "cameraDetect" },
  { group: "cameras", key: "cameraObjects" },
  { group: "cameras", key: "cameraMotion" },
  { group: "cameras", key: "motionTuner" },
  { group: "cameras", key: "cameraFfmpeg" },
  { group: "cameras", key: "cameraRecording" },
  { group: "cameras", key: "cameraSnapshots" },
  { group: "cameras", key: "masksAndZones" },
  { group: "cameras", key: "cameraReview" },
  { group: "cameras", key: "cameraAudioEvents" },
  { group: "cameras", key: "cameraAudioTranscription" },
  { group: "cameras", key: "cameraBirdseye" },
  { group: "cameras", key: "cameraLivePlayback" },
  { group: "cameras", key: "cameraNotifications" },
  { group: "cameras", key: "cameraFaceRecognition" },
  { group: "cameras", key: "cameraLpr" },
  { group: "cameras", key: "cameraOnvif" },
  { group: "cameras", key: "cameraMqttConfig" },
  { group: "cameras", key: "cameraTimestampStyle" },
  { group: "enrichments", key: "integrationSemanticSearch" },
  { group: "enrichments", key: "integrationGenerativeAi" },
  { group: "enrichments", key: "integrationFaceRecognition" },
  { group: "enrichments", key: "integrationLpr" },
  { group: "enrichments", key: "integrationObjectClassification" },
  { group: "enrichments", key: "triggers" },
  { group: "enrichments", key: "integrationAudioTranscription" },
  { group: "system", key: "systemGo2rtcStreams" },
  { group: "system", key: "systemDetectorsAndModel" },
  { group: "system", key: "systemDatabase" },
  { group: "system", key: "systemMqtt" },
  { group: "system", key: "systemBirdseye" },
  { group: "system", key: "systemTls" },
  { group: "system", key: "systemAuthentication" },
  { group: "system", key: "systemNetworking" },
  { group: "system", key: "systemProxy" },
  { group: "system", key: "systemUi" },
  { group: "system", key: "systemLogging" },
  { group: "system", key: "systemEnvironmentVariables" },
  { group: "system", key: "systemTelemetry" },
  { group: "users", key: "users" },
  { group: "users", key: "roles" },
  { group: "notifications", key: "notifications" },
  { group: "frigateplus", key: "frigateplus" },
  { group: "maintenance", key: "mediaSync" },
  { group: "maintenance", key: "regionGrid" },
];

/** Mirrors `ALLOWED_VIEWS_FOR_VIEWER` in `pages/Settings.tsx`. */
export const VIEWER_SETTINGS_SECTIONS = ["uiSettings", "notifications"];
