/**
 * Fork (UI66, UI74): renaming a zone as a single `config/set` request.
 *
 * Renaming moved the name only in review alerts and detections, so snapshots,
 * MQTT, GenAI and autotracking kept the old name and quietly stopped matching,
 * and profile overrides stayed under the old name, which the backend rejects
 * once the base zone is gone. Deleting a zone (`PolygonItem`) already cleans
 * the same set (UI66).
 *
 * The rename also ran as two requests, delete then write, so a rejected write
 * left the camera without the zone. `config/set` applies a whole `config_data`
 * body before it validates, so the delete, the new zone and every moved name
 * now go in one body, and a rejected write changes nothing (UI74).
 */

type ConfigData = Record<string, unknown>;

type ZoneNames = { required_zones: unknown };

/** The parts of a camera's config that name its zones; a `CameraConfig` fits. */
export type ZoneRenameSource = {
  review: { alerts: ZoneNames; detections: ZoneNames };
  objects: { genai: ZoneNames };
  snapshots: ZoneNames;
  mqtt: ZoneNames;
  onvif: { autotracking: ZoneNames };
  profiles?: Record<string, { zones?: Record<string, unknown> }>;
};

function isRecord(value: unknown): value is ConfigData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys that reach `Object.prototype` instead of an own property. Paths come
 * from a query string and zone names from user input, so neither `setPath`
 * nor `mergeInto` ever writes through one (E17).
 */
function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function setPath(target: ConfigData, path: string[], value: unknown) {
  const last = path.at(-1);
  if (last === undefined) return;
  // an unsafe segment anywhere drops the whole write, not only that segment,
  // so the value never lands one level above where the path pointed
  if (path.some(isUnsafeKey)) return;
  let node = target;
  for (const key of path.slice(0, -1)) {
    // repeated as plain comparisons next to the write, which is the form
    // CodeQL's js/prototype-pollution-utility reads as a guard
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return;
    }
    const next = node[key];
    if (isRecord(next)) {
      node = next;
    } else {
      const created: ConfigData = {};
      node[key] = created;
      node = created;
    }
  }
  if (last === "__proto__" || last === "constructor" || last === "prototype") {
    return;
  }
  node[last] = value;
}

function mergeInto(target: ConfigData, source: ConfigData) {
  for (const [key, value] of Object.entries(source)) {
    // `JSON.parse` makes "__proto__" an own key, so `Object.entries` lists it
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const existing = target[key];
    if (isRecord(existing) && isRecord(value)) mergeInto(existing, value);
    else target[key] = value;
  }
}

/**
 * One query value as the backend reads it (`process_config_query_string`):
 * a repeated key is a list, a bare key deletes, and a single value is parsed
 * as a Python literal unless it holds a comma (coordinates, distances).
 */
function queryValue(values: string[]): unknown {
  if (values.length > 1) return values;
  const [value = ""] = values;
  if (value === "") return null;
  if (value.includes(",")) return value;
  if (value === "True") return true;
  if (value === "False") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** The nested `config_data` equivalent of a `config/set` query string. */
export function queryToConfigData(query: string): ConfigData {
  const data: ConfigData = {};
  const params = new URLSearchParams(query);
  for (const key of new Set(params.keys())) {
    setPath(data, key.split("."), queryValue(params.getAll(key)));
  }
  return data;
}

// The backend accepts a bare string for some of these, so check at runtime.
function isZoneList(value: unknown): value is string[] {
  return Array.isArray(value);
}

function requiredZoneLists(camera: ZoneRenameSource): [string, unknown][] {
  return [
    ["review.alerts", camera.review.alerts.required_zones],
    ["review.detections", camera.review.detections.required_zones],
    ["objects.genai", camera.objects.genai.required_zones],
    ["snapshots", camera.snapshots.required_zones],
    ["mqtt", camera.mqtt.required_zones],
    ["onvif.autotracking", camera.onvif.autotracking.required_zones],
  ];
}

/**
 * `config_data` moving the zone's name in every required_zones list and
 * profile override of a base-config camera that names it.
 */
export function zoneRename(
  cameraName: string,
  camera: ZoneRenameSource | undefined,
  oldName: string,
  newName: string,
): ConfigData {
  const data: ConfigData = {};
  if (!camera) return data;

  for (const [section, zones] of requiredZoneLists(camera)) {
    if (!isZoneList(zones) || !zones.includes(oldName)) continue;
    const renamed = new Set(
      zones.map((zone) => (zone === oldName ? newName : zone)),
    );
    setPath(
      data,
      ["cameras", cameraName, ...section.split("."), "required_zones"],
      [...renamed],
    );
  }

  for (const [profile, profileConfig] of Object.entries(
    camera.profiles ?? {},
  )) {
    const override = profileConfig.zones?.[oldName];
    if (override === undefined) continue;
    const zones = ["cameras", cameraName, "profiles", profile, "zones"];
    setPath(data, [...zones, oldName], null);
    setPath(data, [...zones, newName], override);
  }

  return data;
}

/**
 * The whole rename as one `config_data`: delete the zone at `oldPath`, write
 * `zoneQuery` (the editor's query string for the new zone), then apply the
 * moved names from `zoneRename`.
 */
export function zoneRenameConfigData(
  oldPath: string,
  zoneQuery: string,
  moves: ConfigData = {},
): ConfigData {
  const data: ConfigData = {};
  setPath(data, oldPath.split("."), null);
  mergeInto(data, queryToConfigData(zoneQuery));
  mergeInto(data, moves);
  return data;
}
