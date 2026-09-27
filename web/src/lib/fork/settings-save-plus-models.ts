/** Restore Frigate+ model references before the model list is saved. */

import type { DetectionModelConfig } from "@/types/frigateConfig";

const PLUS_PREFIX = "plus://";

// The backend fills these from the Frigate+ model info when it resolves a
// `plus://<id>` path (see check_and_load_plus_model), so persisting them would
// pin values Frigate+ owns
const PLUS_SUPPLIED_FIELDS = [
  "width",
  "height",
  "input_tensor",
  "input_pixel_format",
  "input_dtype",
  "model_type",
];

type SavedModel = Pick<DetectionModelConfig, "path" | "plus">;
type PendingModel = Record<string, unknown> & { path?: unknown };

/**
 * The Frigate+ model id a pending model refers to, if any. An unsaved pick
 * still carries its `plus://<id>` path. A saved Frigate+ model comes back from
 * /api/config with the path resolved to a local cache file, so it is matched
 * to the saved model with the same path that carries Frigate+ metadata.
 */
function plusModelIdFor(
  model: PendingModel,
  savedModels: readonly SavedModel[],
): string | undefined {
  const path = model.path;
  if (typeof path !== "string" || path.length === 0) {
    return undefined;
  }

  if (path.startsWith(PLUS_PREFIX)) {
    return path.slice(PLUS_PREFIX.length) || undefined;
  }

  return savedModels.find((saved) => saved.plus?.id && saved.path === path)
    ?.plus?.id;
}

/**
 * Write Frigate+ models back as `plus://<id>` without the fields Frigate+
 * supplies, so saving does not replace the reference with the resolved cache
 * path. Custom models are returned unchanged.
 */
export function restorePlusModelPaths(
  models: unknown,
  savedModels: readonly SavedModel[] | undefined,
): unknown {
  if (!Array.isArray(models)) {
    return models;
  }

  return models.map((model: unknown) => {
    if (typeof model !== "object" || model === null) {
      return model;
    }

    const record = model as PendingModel;
    const plusId = plusModelIdFor(record, savedModels ?? []);
    if (!plusId) {
      return model;
    }

    const restored: Record<string, unknown> = {
      ...record,
      path: `${PLUS_PREFIX}${plusId}`,
    };
    for (const field of PLUS_SUPPLIED_FIELDS) {
      delete restored[field];
    }
    return restored;
  });
}
