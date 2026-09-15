import { removeRequiredZoneQuery } from "@/utils/zoneEdutUtil";

/**
 * Fork (UI66): what renaming a zone has to change besides the zone itself.
 *
 * Renaming moved the name only in review alerts and detections, so snapshots,
 * MQTT, GenAI and autotracking kept the old name and quietly stopped matching,
 * and profile overrides stayed under the old name, which the backend rejects
 * once the base zone is gone. Deleting a zone (`PolygonItem`) already cleans
 * the same set.
 */

type ZoneNames = { required_zones: unknown };

/** The parts of a camera's config that name its zones; a `CameraConfig` fits. */
export type ZoneRenameSource = {
  objects: { genai: ZoneNames };
  snapshots: ZoneNames;
  mqtt: ZoneNames;
  onvif: { autotracking: ZoneNames };
  profiles?: Record<string, { zones?: Record<string, unknown> }>;
};

export type ZoneRename = {
  /** config/set fragment for the delete request: the old name leaves every list and profile. */
  removals: string;
  /** config/set fragment for the create request: the new name takes the old one's place. */
  additions: string;
  /** `config_data` restoring profile overrides under the new name, if there are any. */
  profileData?: Record<string, unknown>;
};

// The backend accepts a bare string for some of these, so check at runtime.
function isZoneList(value: unknown): value is string[] {
  return Array.isArray(value);
}

function requiredZoneLists(camera: ZoneRenameSource): [string, unknown][] {
  return [
    ["objects.genai", camera.objects.genai.required_zones],
    ["snapshots", camera.snapshots.required_zones],
    ["mqtt", camera.mqtt.required_zones],
    ["onvif.autotracking", camera.onvif.autotracking.required_zones],
  ];
}

export function zoneRename(
  cameraName: string,
  camera: ZoneRenameSource | undefined,
  oldName: string,
  newName: string,
): ZoneRename {
  if (!camera) return { removals: "", additions: "" };

  let removals = "";
  let additions = "";
  for (const [section, zones] of requiredZoneLists(camera)) {
    if (!isZoneList(zones) || !zones.includes(oldName)) continue;
    removals += removeRequiredZoneQuery(oldName, cameraName, section, zones);
    const key = `cameras.${cameraName}.${section}.required_zones`;
    const renamed = new Set(
      zones.map((zone) => (zone === oldName ? newName : zone)),
    );
    additions += [...renamed].map((zone) => `&${key}=${zone}`).join("");
  }

  const overrides: Record<string, { zones: Record<string, unknown> }> = {};
  for (const [profile, profileConfig] of Object.entries(
    camera.profiles ?? {},
  )) {
    const override = profileConfig.zones?.[oldName];
    if (override === undefined) continue;
    removals += `&cameras.${cameraName}.profiles.${profile}.zones.${oldName}`;
    overrides[profile] = { zones: { [newName]: override } };
  }

  const rename: ZoneRename = { removals, additions };
  if (Object.keys(overrides).length > 0) {
    rename.profileData = { cameras: { [cameraName]: { profiles: overrides } } };
  }
  return rename;
}
