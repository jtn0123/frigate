/**
 * Fork: readable diff of the Settings page's pending (unsaved) changes.
 *
 * The Save All flow in `pages/Settings.tsx` already knows how to turn the
 * pending form data of each section into a `config/set` payload and whether
 * that payload needs a restart. This module reuses the same helpers to
 * produce a per-section list of `key: old -> new` rows without touching the
 * save logic itself. The result is memoized on input identity because the
 * sidebar renders one badge per section and all of them read it.
 */

import get from "lodash/get";
import isEqual from "lodash/isEqual";
import type { RJSFSchema } from "@rjsf/utils";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { ConfigSectionData } from "@/types/configForm";
import {
  buildHiddenFieldContext,
  flattenOverrides,
  getBaseCameraSectionValue,
  getSectionConfig,
  mergeProfileOverrides,
  parseProfileFromSectionPath,
  prepareSectionSavePayload,
  resolveHiddenFieldEntries,
  sanitizeSectionData,
} from "@/utils/configUtil";
import { maskCredentials } from "@/utils/credentialMask";

export type SettingsChange = {
  path: string;
  oldValue: unknown;
  newValue: unknown;
};

export type SettingsSectionDiff = {
  pendingKey: string;
  scope: "global" | "camera";
  /** Set for camera-scoped sections. */
  cameraName: string | undefined;
  /** Set when the section edits a profile override. */
  profileName: string | undefined;
  /** Config section this entry writes to, e.g. `detect` or `go2rtc.streams`. */
  section: string;
  needsRestart: boolean;
  changes: SettingsChange[];
};

type PendingMap = Record<string, ConfigSectionData>;

function flattenLeaves(
  value: unknown,
  path: string[],
  out: Map<string, unknown>,
) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out.set(path.join("."), {});
      return;
    }
    entries.forEach(([key, entry]) =>
      flattenLeaves(entry, [...path, key], out),
    );
    return;
  }
  out.set(path.join("."), value);
}

/** Leaf-level diff of two plain objects, sorted by path. */
export function diffValues(oldValue: unknown, newValue: unknown) {
  const oldMap = new Map<string, unknown>();
  const newMap = new Map<string, unknown>();
  flattenLeaves(oldValue, [], oldMap);
  flattenLeaves(newValue, [], newMap);
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  return [...paths]
    .filter((path) => !isEqual(oldMap.get(path), newMap.get(path)))
    .sort((left, right) => left.localeCompare(right))
    .map<SettingsChange>((path) => ({
      path,
      oldValue: oldMap.get(path),
      newValue: newMap.get(path),
    }));
}

function parsePendingKey(pendingKey: string) {
  const idx = pendingKey.indexOf("::");
  if (idx === -1) {
    return { scope: "global" as const, sectionPath: pendingKey };
  }
  return {
    scope: "camera" as const,
    cameraName: pendingKey.slice(0, idx),
    sectionPath: pendingKey.slice(idx + 2),
  };
}

function getUnknown(object: unknown, path: string): unknown {
  return get(object, path) as unknown;
}

function objectEntries(value: unknown): Array<[string, unknown]> {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value);
}

function go2rtcDiff(
  pending: Record<string, string[]>,
  config: FrigateConfig,
): SettingsSectionDiff {
  const saved: Record<string, string[]> = {};
  for (const [name, urls] of objectEntries(
    getUnknown(config, "go2rtc.streams"),
  )) {
    saved[name] = (Array.isArray(urls) ? urls : [urls]).map((url) =>
      maskCredentials(String(url)),
    );
  }
  const live: Record<string, string[]> = {};
  for (const [name, urls] of Object.entries(pending)) {
    const list = Array.isArray(urls) ? urls : [];
    live[name] = list.map((url) => maskCredentials(url));
  }
  return {
    pendingKey: "go2rtc_streams",
    scope: "global",
    cameraName: undefined,
    profileName: undefined,
    section: "go2rtc.streams",
    needsRestart: false,
    changes: diffValues(saved, live),
  };
}

function isSectionData(value: unknown): value is ConfigSectionData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `detectors` or `model` as Save All writes it: without the fields the forms
 * hide. /api/config adds runtime fields to both (colormap, attribute lists,
 * Frigate+ data, each detector's merged labelmap) that Save All never writes.
 */
function savedForm(
  key: "detectors" | "model",
  value: unknown,
  config: FrigateConfig,
): ConfigSectionData {
  return sanitizeSectionData(
    isSectionData(value) ? value : {},
    resolveHiddenFieldEntries(
      getSectionConfig(key, "global").hiddenFields,
      buildHiddenFieldContext(config, "global"),
    ),
  );
}

function isPlusModel(path: unknown) {
  return typeof path === "string" && path.startsWith("plus://");
}

/**
 * Whether Save All clears `detectors` and `model` before writing them, as
 * `handleSaveAll` does when a detector is added, removed or renamed, or the
 * model switches between Frigate+ and a custom one. Otherwise it merges the
 * pending data into the stored sections and keys it lacks stay as they are.
 */
function saveAllClearsDetectorsAndModel(
  pending: PendingMap,
  config: FrigateConfig,
): boolean {
  const sections = new Map(Object.entries(pending));
  const detectors = sections.get("detectors");
  if (detectors) {
    const pendingNames = Object.keys(detectors);
    const savedNames = new Set(
      objectEntries(getUnknown(config, "detectors")).map(([name]) => name),
    );
    if (
      pendingNames.length !== savedNames.size ||
      pendingNames.some((name) => !savedNames.has(name))
    ) {
      return true;
    }
  }
  const model = sections.get("model");
  if (model) {
    const path = getUnknown(savedForm("model", model, config), "path");
    return isPlusModel(path) !== isPlusModel(getUnknown(config, "model.path"));
  }
  return false;
}

function schemaSectionDiff(
  pendingKey: string,
  pendingData: ConfigSectionData,
  config: FrigateConfig,
  fullSchema: RJSFSchema,
): SettingsSectionDiff | null {
  const payload = prepareSectionSavePayload({
    pendingDataKey: pendingKey,
    pendingData,
    config,
    fullSchema,
  });
  if (!payload) return null;

  const { scope, cameraName, sectionPath } = parsePendingKey(pendingKey);
  const { isProfile, profileName, actualSection } =
    parseProfileFromSectionPath(sectionPath);

  // Resolve the stored value the form was diffed against, mirroring
  // prepareSectionSavePayload so old values line up with the overrides.
  let base: unknown;
  if (scope === "camera" && cameraName) {
    base = getBaseCameraSectionValue(config, cameraName, actualSection);
    if (isProfile) {
      const overrides = getUnknown(config.cameras[cameraName], sectionPath);
      if (
        overrides &&
        typeof overrides === "object" &&
        base &&
        typeof base === "object"
      ) {
        base = mergeProfileOverrides(base as object, overrides as object);
      }
    }
  } else {
    base = getUnknown(config, sectionPath);
  }

  const changes = flattenOverrides(payload.sanitizedOverrides).map(
    ({ path, value }) => ({
      path,
      oldValue: path ? getUnknown(base, path) : base,
      newValue: value,
    }),
  );

  return {
    pendingKey,
    scope,
    cameraName,
    profileName: isProfile ? profileName : undefined,
    section: actualSection,
    needsRestart: payload.needsRestart,
    changes,
  };
}

export function computeSettingsDiff(
  pending: PendingMap,
  config: FrigateConfig | undefined,
  fullSchema: RJSFSchema | undefined,
): SettingsSectionDiff[] {
  if (!config) return [];
  const out: SettingsSectionDiff[] = [];
  const clearsDetectorsAndModel = saveAllClearsDetectorsAndModel(
    pending,
    config,
  );

  for (const [pendingKey, pendingData] of Object.entries(pending)) {
    if (pendingKey === "detectors" || pendingKey === "model") {
      // Owned by DetectorsAndModelSettingsView; Save All always restarts.
      const changes = diffValues(
        savedForm(pendingKey, getUnknown(config, pendingKey), config),
        savedForm(pendingKey, pendingData, config),
      );
      out.push({
        pendingKey,
        scope: "global",
        cameraName: undefined,
        profileName: undefined,
        section: pendingKey,
        needsRestart: true,
        changes: clearsDetectorsAndModel
          ? changes
          : changes.filter((change) => change.newValue !== undefined),
      });
      continue;
    }
    if (pendingKey === "go2rtc_streams") {
      out.push(
        go2rtcDiff(pendingData as unknown as Record<string, string[]>, config),
      );
      continue;
    }
    if (!fullSchema) continue;
    const diff = schemaSectionDiff(pendingKey, pendingData, config, fullSchema);
    if (diff) out.push(diff);
  }

  return out.sort((left, right) => {
    if (left.scope !== right.scope) return left.scope === "global" ? -1 : 1;
    const camera = (left.cameraName ?? "").localeCompare(
      right.cameraName ?? "",
    );
    if (camera !== 0) return camera;
    return left.section.localeCompare(right.section);
  });
}

let cache: {
  pending: PendingMap;
  config: FrigateConfig | undefined;
  fullSchema: RJSFSchema | undefined;
  result: SettingsSectionDiff[];
} | null = null;

/** Identity-memoized `computeSettingsDiff` shared by every consumer. */
export function getSettingsDiff(
  pending: PendingMap,
  config: FrigateConfig | undefined,
  fullSchema: RJSFSchema | undefined,
): SettingsSectionDiff[] {
  if (
    cache?.pending === pending &&
    cache.config === config &&
    cache.fullSchema === fullSchema
  ) {
    return cache.result;
  }
  const result = computeSettingsDiff(pending, config, fullSchema);
  cache = { pending, config, fullSchema, result };
  return result;
}
