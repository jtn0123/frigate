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

  if ("models" in pendingDataBySection) {
    try {
      const hiddenFields = resolveHiddenFieldEntries(
        getSectionConfig("models", "global").hiddenFields,
        buildHiddenFieldContext(config, "global"),
      );
      const models = sanitizeSectionData(
        pendingDataBySection["models"]!,
        hiddenFields,
      );
      await api.put("config/set", {
        requires_restart: 0,
        config_data: { models },
      });
      result.keysToClear.push("models");
      result.savedKeys.push("models");
      result.successCount++;
      result.anyNeedsRestart = true;
    } catch (error) {
      result.failCount++;
      result.failures.push({ key: "models", error });
    }
  }

  if ("go2rtc_streams" in pendingDataBySection) {
    try {
      const liveStreams = pendingDataBySection["go2rtc_streams"] as Record<
        string,
        string[]
      >;
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
            api.put(
              `go2rtc/streams/${name}?src=${encodeURIComponent(urls[0])}`,
            ),
          );
        }
      }
      for (const name of deletedNames) {
        updates.push(api.remove(`go2rtc/streams/${name}`));
      }
      await Promise.allSettled(updates);

      result.keysToClear.push("go2rtc_streams");
      result.savedKeys.push("go2rtc_streams");
      result.successCount++;
    } catch (error) {
      result.failCount++;
      result.failures.push({ key: "go2rtc_streams", error });
    }
  }

  for (const [key, pendingData] of Object.entries(pendingDataBySection)) {
    if (key === "models" || key === "go2rtc_streams") {
      continue;
    }
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
        result.anyNeedsRestart ||= payload.needsRestart;
        result.savedKeys.push(key);
      }
      result.keysToClear.push(key);
      result.successCount++;
    } catch (error) {
      result.failCount++;
      result.failures.push({ key, error });
    }
  }

  return result;
}
