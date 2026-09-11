/**
 * Path-typed reads against the generated OpenAPI spec (A5).
 *
 * SWR keys stay the existing axios-relative strings (`config`, not
 * `/config`) so these hooks share cache with remaining `useSWR` calls.
 * Response shapes for `/config` and `/stats` are still the hand-written
 * types because the spec documents those 200s as empty objects. `/review`
 * is overlaid too: the spec uses date-time strings and omits
 * `significant_motion`, but the app and the live server use unix seconds
 * and that severity. B2 replaces the overlays when the spec matches.
 */
import useSWR, { type SWRConfiguration, type SWRResponse } from "swr";
import axios from "axios";
import type { components, paths } from "@/types/fork/api.gen";
import type { Event } from "@/types/event";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { ReviewSegment } from "@/types/review";
import type { FrigateStats } from "@/types/stats";

export const PATH_TO_KEY = {
  "/config": "config",
  "/review": "review",
  "/events": "events",
  "/stats": "stats",
  "/stats/history": "stats/history",
} as const;

export type MigratedPath = keyof typeof PATH_TO_KEY;

type GetJson<P extends keyof paths> = paths[P] extends {
  get: {
    responses: {
      200: { content: { "application/json": infer R } };
    };
  };
}
  ? R
  : never;

type RuntimeOverlay = {
  "/config": FrigateConfig;
  "/stats": FrigateStats;
  "/stats/history": FrigateStats[];
  "/review": ReviewSegment[];
  "/events": Event[];
};

export type ApiResponse<P extends MigratedPath> = P extends keyof RuntimeOverlay
  ? RuntimeOverlay[P]
  : GetJson<P>;

export type UseApiOptions<P extends MigratedPath> = SWRConfiguration<
  ApiResponse<P>
> & {
  params?: Record<string, unknown>;
};

/**
 * Compile-time handle on a spec field. Renaming
 * `ReviewSegmentResponse.id` in the yaml and regenerating fails here.
 */
export function reviewSpecId(
  row: components["schemas"]["ReviewSegmentResponse"],
): string {
  return row.id;
}

export function eventSpecId(
  row: components["schemas"]["EventResponse"],
): string {
  return row.id;
}

export function swrKey<P extends MigratedPath>(
  path: P,
  params?: Record<string, unknown>,
): string | [string, Record<string, unknown>] {
  const key = PATH_TO_KEY[path];
  return params === undefined ? key : [key, params];
}

export function useApi<P extends MigratedPath>(
  path: P | null,
  options?: UseApiOptions<P>,
): SWRResponse<ApiResponse<P>> {
  const { params, ...swrOptions } = options ?? {};
  const key = path === null ? null : swrKey(path, params);
  return useSWR<ApiResponse<P>>(key, swrOptions);
}

export async function apiGet<P extends MigratedPath>(
  path: P,
  params?: Record<string, unknown>,
): Promise<ApiResponse<P>> {
  const { data } = await axios.get<ApiResponse<P>>(PATH_TO_KEY[path], {
    params,
  });
  return data;
}
