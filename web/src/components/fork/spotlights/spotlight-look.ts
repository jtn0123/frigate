/**
 * What a Spotlights card says about an item (fork, UI144): the chip text,
 * icon and color for each reason, the title, and the similarity search link.
 * Kept out of the component file so it can be tested on its own.
 */

import type { IconType } from "react-icons";
import {
  LuCar,
  LuCircleDot,
  LuRectangleHorizontal,
  LuScanFace,
  LuShieldAlert,
  LuTag,
  LuTimer,
  LuVolume2,
} from "react-icons/lu";
import type { SpotlightReason } from "@/lib/fork/spotlights";
import { cn } from "@/lib/utils";
import type { ReviewSegment } from "@/types/review";
import { getTranslatedLabel } from "@/utils/i18n";
import { sortedStrings } from "@/utils/stringSort";
import { formatList } from "@/utils/stringUtil";

/** The slice of i18next's `t` these helpers use. */
export type Translate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

const RED = "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
const AMBER =
  "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300";
const SKY = "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300";
const VIOLET =
  "border-violet-500/40 bg-violet-500/10 text-violet-800 dark:text-violet-300";
const TEAL =
  "border-teal-500/40 bg-teal-500/10 text-teal-800 dark:text-teal-300";
const NEUTRAL = "border-secondary-foreground/20 bg-secondary text-primary";

/*
 * Each call names its namespace so the key extractor files the keys under
 * fork, not common.
 */

/** The friendlier name of a notable sound, or its audio label. */
export function audioName(t: Translate, label: string): string {
  switch (label) {
    case "glass":
      return t("spotlights.audio.glass", { ns: "fork" });
    case "shatter":
      return t("spotlights.audio.shatter", { ns: "fork" });
    case "breaking":
      return t("spotlights.audio.breaking", { ns: "fork" });
    case "gunshot":
      return t("spotlights.audio.gunshot", { ns: "fork" });
    case "explosion":
      return t("spotlights.audio.explosion", { ns: "fork" });
    case "scream":
      return t("spotlights.audio.scream", { ns: "fork" });
    case "smoke_detector":
      return t("spotlights.audio.smoke_detector", { ns: "fork" });
    case "fire_alarm":
      return t("spotlights.audio.fire_alarm", { ns: "fork" });
    case "siren":
      return t("spotlights.audio.siren", { ns: "fork" });
    case "civil_defense_siren":
      return t("spotlights.audio.civil_defense_siren", { ns: "fork" });
    case "car_alarm":
      return t("spotlights.audio.car_alarm", { ns: "fork" });
    case "alarm":
      return t("spotlights.audio.alarm", { ns: "fork" });
    case "yell":
      return t("spotlights.audio.yell", { ns: "fork" });
    default:
      return getTranslatedLabel(label, "audio");
  }
}

export type ChipLook = {
  text: string;
  title?: string;
  icon: IconType;
  tone: string;
};

export function reasonLook(
  t: Translate,
  reason: SpotlightReason,
  /** The display name of a zone on the item's camera. */
  zoneName: (zone: string) => string,
): ChipLook {
  switch (reason.kind) {
    case "threat":
      return {
        text: t("spotlights.reasons.threat", {
          ns: "fork",
          level: reason.level,
        }),
        title:
          reason.level >= 2
            ? t("securityConcern", { ns: "views/events" })
            : t("needsReview", { ns: "views/events" }),
        icon: LuShieldAlert,
        tone: reason.level >= 2 ? RED : AMBER,
      };
    case "audio":
      return {
        text: audioName(t, reason.label),
        icon: LuVolume2,
        tone: reason.critical ? RED : AMBER,
      };
    case "face":
      return {
        text: t("spotlights.reasons.face", { ns: "fork", name: reason.name }),
        icon: LuScanFace,
        tone: SKY,
      };
    case "knownPlate":
      return {
        text: t("spotlights.reasons.knownPlate", {
          ns: "fork",
          name: reason.name,
        }),
        icon: LuCar,
        tone: VIOLET,
      };
    case "plate":
      return {
        text: t("spotlights.reasons.plate", {
          ns: "fork",
          plate: reason.plate,
        }),
        icon: LuRectangleHorizontal,
        tone: VIOLET,
      };
    case "identified":
      return {
        text: t("spotlights.reasons.identified", {
          ns: "fork",
          name: reason.name,
        }),
        icon: LuTag,
        tone: TEAL,
      };
    case "loitering":
      return {
        text: t("spotlights.reasons.loitering", {
          ns: "fork",
          zone: zoneName(reason.zone),
        }),
        icon: LuTimer,
        tone: AMBER,
      };
    case "alert":
      return {
        text: t("spotlights.reasons.alert", { ns: "fork" }),
        icon: LuCircleDot,
        tone: NEUTRAL,
      };
    case "unreviewed":
      return {
        text: t("spotlights.reasons.unreviewed", { ns: "fork" }),
        icon: LuCircleDot,
        tone: cn(NEUTRAL, "border-dashed"),
      };
  }
}

/** The GenAI title, or what was seen and heard. */
export function itemTitle(review: ReviewSegment): string {
  if (review.data.metadata?.title) {
    return review.data.metadata.title;
  }
  const objects = sortedStrings(
    new Set(review.data.objects.map((label) => label.replace("-verified", ""))),
  ).map((label) => getTranslatedLabel(label));
  const sounds = sortedStrings(new Set(review.data.audio)).map((label) =>
    getTranslatedLabel(label, "audio"),
  );
  return formatList([...objects, ...sounds]);
}

/** Explore's similarity search for the item's first tracked object. */
export function findSimilarPath(
  review: ReviewSegment,
  semanticSearch: boolean,
): string | undefined {
  const eventId = review.data.detections.at(0);
  if (!semanticSearch || review.data.objects.length === 0 || !eventId) {
    return undefined;
  }
  const params = new URLSearchParams({
    search_type: "similarity",
    event_id: eventId,
  });
  return `/explore?${params.toString()}`;
}
