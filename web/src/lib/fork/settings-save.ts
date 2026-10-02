/** Execute the Settings Save All writes while keeping UI state in the caller. */

import type { RJSFSchema } from "@rjsf/utils";
import type { ConfigSectionData } from "@/types/configForm";
import type { FrigateConfig } from "@/types/frigateConfig";
import {
  buildConfigDataForPath,
  buildHiddenFieldContext,
  getSectionConfig,
  prepareSectionSavePayload,
  resolveHiddenFieldEntries,
  sanitizeSectionData,
} from "@/utils/configUtil";
import { compareGo2RtcStreams } from "./go2rtc-streams";
import { restorePlusModelPaths } from "./settings-save-plus-models";

type SaveApi = {
  put: (url: string, data?: unknown) => Promise<unknown>;
  remove: (url: string) => Promise<unknown>;
};

export type SaveAllResult = {
  successCount: number;
  failCount: number;
  anyNeedsRestart: boolean;
  savedKeys: string[];
  keysToClear: string[];
  failures: Array<{ key: string; error: unknown }>;
};

type SaveContext = {
  config: FrigateConfig;
  fullSchema: RJSFSchema;
  api: SaveApi;
  result: SaveAllResult;
};

/** Record a section that failed, so the caller keeps it for a retry. */
function recordFailure(result: SaveAllResult, key: string, error: unknown) {
  result.failCount++;
  result.failures.push({ key, error });
}

/** Record a section whose pending data can be cleared. */
function recordSuccess(result: SaveAllResult, key: string, saved: boolean) {
  result.keysToClear.push(key);
  if (saved) result.savedKeys.push(key);
  result.successCount++;
}

async function saveModels(
  { config, api, result }: SaveContext,
  pending: ConfigSectionData,
) {
  try {
    const hiddenFields = resolveHiddenFieldEntries(
      getSectionConfig("models", "global").hiddenFields,
      buildHiddenFieldContext(config, "global"),
    );
    const models = restorePlusModelPaths(
      sanitizeSectionData(pending, hiddenFields),
      config.models,
    );
    await api.put("config/set", {
      requires_restart: 0,
      config_data: { models },
    });
  } catch (error) {
    recordFailure(result, "models", error);
    return;
  }
  recordSuccess(result, "models", true);
  result.anyNeedsRestart = true;
}

async function saveGo2rtcStreams(
  { config, api, result }: SaveContext,
  pending: ConfigSectionData | undefined,
) {
  try {
    const liveStreams = pending as Record<string, string[]>;
    const { deletedNames } = compareGo2RtcStreams(
      (config.go2rtc as typeof config.go2rtc | undefined)?.streams,
      liveStreams,
    );
    const streamsPayload: Record<string, string[] | string> = {
      ...liveStreams,
    };
    for (const name of deletedNames) streamsPayload[name] = "";
    await api.put("config/set", {
      requires_restart: 0,
      config_data: { go2rtc: { streams: streamsPayload } },
    });

    const updates: Promise<unknown>[] = [];
    for (const [name, urls] of Object.entries(liveStreams)) {
      if (urls[0]) {
        updates.push(
          api.put(`go2rtc/streams/${name}?src=${encodeURIComponent(urls[0])}`),
        );
      }
    }
    for (const name of deletedNames) {
      updates.push(api.remove(`go2rtc/streams/${name}`));
    }
    await Promise.allSettled(updates);
  } catch (error) {
    recordFailure(result, "go2rtc_streams", error);
    return;
  }
  recordSuccess(result, "go2rtc_streams", true);
}

async function saveSection(
  { config, fullSchema, api, result }: SaveContext,
  key: string,
  pendingData: ConfigSectionData,
) {
  let saved = false;
  let needsRestart = false;
  try {
    const payload = prepareSectionSavePayload({
      pendingDataKey: key,
      pendingData,
      config,
      fullSchema,
    });
    if (payload) {
      await api.put("config/set", {
        requires_restart: payload.needsRestart ? 1 : 0,
        update_topic: payload.updateTopic,
        config_data: buildConfigDataForPath(
          payload.basePath,
          payload.sanitizedOverrides,
        ),
      });
      saved = true;
      needsRestart = payload.needsRestart;
    }
  } catch (error) {
    recordFailure(result, key, error);
    return;
  }
  result.anyNeedsRestart ||= needsRestart;
  recordSuccess(result, key, saved);
}

/** Save independent sections in order and retain failed sections for retry. */
export async function savePendingSettings({
  config,
  fullSchema,
  pendingDataBySection,
  api,
}: {
  config: FrigateConfig;
  fullSchema: RJSFSchema;
  pendingDataBySection: Record<string, ConfigSectionData>;
  api: SaveApi;
}): Promise<SaveAllResult> {
  const result: SaveAllResult = {
    successCount: 0,
    failCount: 0,
    anyNeedsRestart: false,
    savedKeys: [],
    keysToClear: [],
    failures: [],
  };
  const context: SaveContext = { config, fullSchema, api, result };

  if ("models" in pendingDataBySection) {
    await saveModels(context, pendingDataBySection["models"]!);
  }

  if ("go2rtc_streams" in pendingDataBySection) {
    await saveGo2rtcStreams(context, pendingDataBySection["go2rtc_streams"]);
  }

  for (const [key, pendingData] of Object.entries(pendingDataBySection)) {
    if (key === "models" || key === "go2rtc_streams") {
      continue;
    }
    // Sequential on purpose: every section is a read-modify-write of the
    // same config file, so parallel PUTs would race and drop each other.
    await saveSection(context, key, pendingData); // NOSONAR
  }

  return result;
}
