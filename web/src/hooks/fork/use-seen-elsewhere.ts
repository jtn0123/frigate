/**
 * Reads behind "Seen on other cameras" (fork UI145): the same name and the
 * same plate on the other cameras the user can see, plus CLIP look-alikes
 * when semantic search is on. Each read is skipped when it has nothing to
 * ask for, so an object with no face, plate or embedding costs nothing.
 */

import { useEffect, useMemo, useState } from "react";
import useSWR, { type SWRConfiguration, type SWRResponse } from "swr";
import { useAllowedCameras } from "@/hooks/use-allowed-cameras";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { SearchResult } from "@/types/search";
import { isAttributeOfLabel } from "@/utils/modelUtil";
import {
  LIVE_REFRESH_MS,
  buildSightings,
  identityParams,
  mergeSides,
  otherCameras,
  seenIdentities,
  seenSetup,
  seenWindow,
  sideFull,
  similarParams,
  type SeenIdentity,
  type SeenRange,
  type SeenSide,
  type SeenWindow,
} from "@/lib/fork/seen-elsewhere";

// keepPreviousData: a new window shows the last answer until its own lands
// (the panel is keyed by object, so the last answer is this object's)
const READ_OPTIONS: SWRConfiguration = {
  revalidateOnFocus: false,
  keepPreviousData: true,
};

// an object still in view: the same keys are read again every minute, which
// SWR does in the background, so the panel neither dims nor jumps
const LIVE_READ_OPTIONS: SWRConfiguration = {
  ...READ_OPTIONS,
  refreshInterval: LIVE_REFRESH_MS,
};

type Read<T> = Pick<SWRResponse<T>, "data" | "error" | "isLoading">;

/** This read's answer, or nothing if it failed. */
function answerOf<T>(read: Read<T>): T | undefined {
  return read.error ? undefined : read.data;
}

/** Loading with nothing to show yet. */
function waiting<T>(read: Read<T>): boolean {
  return read.isLoading && read.data === undefined;
}

/** Loading a new window with the last one's answer still on screen. */
function stale<T>(read: Read<T>): boolean {
  return read.isLoading && read.data !== undefined;
}

/** Unix seconds, ticking each minute while `live` so a moving window follows. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!live) {
      return;
    }
    const timer = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      LIVE_REFRESH_MS,
    );
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/** One side of one identity's sightings; skipped without an identity. */
function useSideRead(
  identity: SeenIdentity | undefined,
  side: SeenSide,
  range: SeenRange,
  cameras: string[],
) {
  return useSWR<SearchResult[]>(
    identity && cameras.length > 0
      ? ["events", identityParams(identity, range, cameras, side)]
      : null,
    range.live ? LIVE_READ_OPTIONS : READ_OPTIONS,
  );
}

export function useSeenElsewhere(search: SearchResult, choice: SeenWindow) {
  const { data: config } = useSWR<FrigateConfig>("config", READ_OPTIONS);
  const allowedCameras = useAllowedCameras();
  const cameras = useMemo(
    () => otherCameras(allowedCameras, search.camera),
    [allowedCameras, search.camera],
  );

  const subLabel = search.sub_label;
  const plateText = search.data.recognized_license_plate;
  const identities = useMemo(
    () => seenIdentities(subLabel, plateText),
    [subLabel, plateText],
  );
  const hasCameras = cameras.length > 0;
  const name = identities.find((identity) => identity.kind === "name");
  const plate = identities.find((identity) => identity.kind === "plate");
  // embeddings exist for tracked objects only, not audio or manual events
  const canSimilar =
    !!config?.semantic_search.enabled &&
    search.data.type !== "audio" &&
    search.data.type !== "manual";
  const active = hasCameras && (identities.length > 0 || canSimilar);

  // An object still in view has no end time, and the dialog's copy of it is
  // not refreshed, so its own row is read again each minute until it ends.
  const ownRead = useSWR<SearchResult>(
    active && search.end_time == null ? `events/${search.id}` : null,
    {
      ...READ_OPTIONS,
      refreshInterval: (latest) =>
        latest?.end_time == null ? LIVE_REFRESH_MS : 0,
    },
  );
  const endTime = search.end_time ?? ownRead.data?.end_time ?? undefined;
  const now = useNow(active && endTime == null);
  const range = useMemo(
    () =>
      seenWindow(choice, search.start_time, endTime, now, config?.ui.timezone),
    [choice, search.start_time, endTime, now, config?.ui.timezone],
  );

  const nameEarlier = useSideRead(name, "earlier", range, cameras);
  const nameLater = useSideRead(name, "later", range, cameras);
  const plateEarlier = useSideRead(plate, "earlier", range, cameras);
  const plateLater = useSideRead(plate, "later", range, cameras);
  const identityReads = [nameEarlier, nameLater, plateEarlier, plateLater];
  const similarRead = useSWR<SearchResult[]>(
    hasCameras && canSimilar
      ? [
          "events/search",
          similarParams(search.id, search.label, range, cameras),
        ]
      : null,
    range.live ? LIVE_READ_OPTIONS : READ_OPTIONS,
  );

  const nameEarlierAnswer = answerOf(nameEarlier);
  const nameLaterAnswer = answerOf(nameLater);
  const plateEarlierAnswer = answerOf(plateEarlier);
  const plateLaterAnswer = answerOf(plateLater);
  const nameAnswer = useMemo(
    () => mergeSides(nameEarlierAnswer, nameLaterAnswer),
    [nameEarlierAnswer, nameLaterAnswer],
  );
  const plateAnswer = useMemo(
    () => mergeSides(plateEarlierAnswer, plateLaterAnswer),
    [plateEarlierAnswer, plateLaterAnswer],
  );
  const similarAnswer = answerOf(similarRead);
  const current = useMemo(
    () => ({
      id: search.id,
      camera: search.camera,
      start_time: search.start_time,
      end_time: endTime,
    }),
    [search.id, search.camera, search.start_time, endTime],
  );
  const sightings = useMemo(
    () =>
      buildSightings(current, {
        name: nameAnswer,
        plate: plateAnswer,
        similar: similarAnswer,
      }),
    [current, nameAnswer, plateAnswer, similarAnswer],
  );

  const plateLabel = isAttributeOfLabel(config, search.label, "license_plate");
  const cameraConfig = config?.cameras[search.camera];
  // nothing to follow: which feature an admin could turn on to change that
  const setup =
    config && hasCameras && !active
      ? seenSetup({
          label: search.label,
          type: search.data.type,
          plateLabel,
          faceRecognition:
            config.face_recognition.enabled &&
            cameraConfig?.face_recognition.enabled !== false,
          plateRecognition:
            config.lpr.enabled && cameraConfig?.lpr.enabled !== false,
          semanticSearch: config.semantic_search.enabled,
        })
      : undefined;

  return {
    config,
    identities,
    range,
    /** The object as the strip draws it, with its end once it has one. */
    current,
    /** Unix seconds; moves each minute while the object is in view. */
    now,
    canSimilar,
    /** Whether the panel has anything it could look for. */
    active,
    /** When it has not, the setting that would give it something. */
    setup,
    matched: sightings.matched,
    similar: sightings.similar,
    /** A side came back full, so the farthest sightings were left out. */
    capped: [
      nameEarlierAnswer,
      nameLaterAnswer,
      plateEarlierAnswer,
      plateLaterAnswer,
    ].some(sideFull),
    loadingMatched: identityReads.some(waiting),
    loadingSimilar: waiting(similarRead),
    /** A new window is loading over the last one's answer. */
    refreshing: [...identityReads, similarRead].some(stale),
    failed:
      identityReads.some((read) => !!read.error) && !nameAnswer && !plateAnswer,
  };
}
