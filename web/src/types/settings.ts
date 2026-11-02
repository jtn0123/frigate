/**
 * The Settings page section index.
 *
 * This is the single source for which sections exist, what order they appear
 * in, and which group each one belongs to. It lives outside
 * `pages/Settings.tsx` so that callers which only need to link to a section
 * (the command menu) do not pull every settings view into their bundle.
 * `pages/Settings.tsx` maps these keys onto the components that render them.
 */

/** The words of a space-separated string literal, as a union of literals. */
type Words<S extends string> = S extends `${infer Head} ${infer Rest}`
  ? Head | Words<Rest>
  : S;

/**
 * One menu group. Its views are written as one space-separated string so the
 * index stays a short table instead of long uniform lists (UI156).
 */
function viewGroup<const Label extends string, const Views extends string>(
  label: Label,
  views: Views,
): { label: Label; views: Words<Views>[] } {
  return { label, views: views.split(" ") as Words<Views>[] };
}

export const settingsViewGroups = [
  viewGroup("general", "uiSettings"),
  viewGroup(
    "globalConfig",
    "profiles cameraManagement globalDetect globalObjects globalMotion globalFfmpeg globalRecording globalSnapshots globalReview globalAudioEvents globalLivePlayback globalTimestampStyle",
  ),
  viewGroup(
    "cameras",
    "cameraDetect cameraObjects cameraMotion motionTuner cameraFfmpeg cameraRecording cameraSnapshots masksAndZones cameraReview cameraAudioEvents cameraAudioTranscription cameraBirdseye cameraLivePlayback cameraNotifications cameraFaceRecognition cameraLpr cameraOnvif cameraMqttConfig cameraTimestampStyle",
  ),
  viewGroup(
    "enrichments",
    "integrationSemanticSearch integrationGenerativeAi integrationFaceRecognition integrationLpr integrationObjectClassification triggers integrationAudioTranscription",
  ),
  viewGroup(
    "system",
    "systemGo2rtcStreams systemDetectorsAndModel systemDatabase systemMqtt systemBirdseye systemTls systemAuthentication systemNetworking systemProxy systemUi systemLogging systemEnvironmentVariables systemTelemetry",
  ),
  viewGroup("users", "users roles"),
  viewGroup("notifications", "notifications"),
  viewGroup("frigateplus", "frigateplus"),
  viewGroup("maintenance", "mediaSync regionGrid"),
] as const;

/** `enrichments` and `debug` are reachable in the UI but have no menu entry. */
export type SettingsType =
  | (typeof settingsViewGroups)[number]["views"][number]
  | "enrichments"
  | "debug";

export const allSettingsViews: SettingsType[] = [
  ...settingsViewGroups.flatMap((group) => group.views),
  "enrichments",
  "debug",
];

/** Sections a viewer may open. Everything else is admin only. */
export const ALLOWED_VIEWS_FOR_VIEWER: SettingsType[] = [
  "uiSettings",
  "notifications",
];
