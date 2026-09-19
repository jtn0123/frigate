/**
 * Fork: helpers for config-form empty states (UI105).
 *
 * A map section (Generative AI providers) opts into an empty state with the
 * root uiSchema option `forkEmptyState`. `ObjectFieldTemplate` shows it while
 * the map has no entries, and `BaseSection` hides its Save / Reset bar while
 * the map is empty, saved that way and not edited.
 */

import type { UiSchema } from "@rjsf/utils";

/** The kinds a section can name in `ui:options.forkEmptyState`. */
export type ConfigEmptyStateKind = "genaiProviders";

/** The empty-state kind a section's root uiSchema opts into, if any. */
export function configEmptyStateKind(
  uiSchema: UiSchema | undefined,
): ConfigEmptyStateKind | undefined {
  const kind: unknown = uiSchema?.["ui:options"]?.["forkEmptyState"];
  return kind === "genaiProviders" ? kind : undefined;
}

/** True for a missing value or a plain object with no keys. */
export function isEmptyMap(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  return (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
