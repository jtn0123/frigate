/**
 * Fork (D78): suggest a UI timezone without saving it.
 *
 * The Settings page keeps every section's unsaved edits by key, so a draft
 * of the `ui` section with the timezone set shows up on the UI page as an
 * ordinary unsaved change that the admin can save or undo.
 */

import { isJsonObject } from "@/lib/utils";
import type { ConfigSectionData } from "@/types/configForm";
import type { FrigateConfig } from "@/types/frigateConfig";
import {
  buildHiddenFieldContext,
  getEffectiveHiddenFields,
  sanitizeSectionData,
} from "@/utils/configUtil";

/** The Settings page's key for the global `ui` section's unsaved edits. */
export const UI_SECTION_KEY = "ui";

/**
 * The `ui` section's draft with `timezone` set to `zone`.
 *
 * Args:
 *     config: The saved config.
 *     pending: The `ui` section's unsaved edits, if there are any.
 *     zone: The IANA timezone to suggest.
 *
 * Returns:
 *     The edits so far, or the saved section, with the timezone set.
 */
export function uiTimezoneDraft(
  config: FrigateConfig,
  pending: ConfigSectionData | undefined,
  zone: string,
): ConfigSectionData {
  if (pending) {
    return { ...pending, timezone: zone };
  }
  const savedUi: unknown = config.ui;
  const saved = sanitizeSectionData(
    isJsonObject(savedUi) ? savedUi : {},
    getEffectiveHiddenFields(
      UI_SECTION_KEY,
      "global",
      buildHiddenFieldContext(config, "global"),
    ),
  );
  return { ...saved, timezone: zone };
}
