/**
 * Spotlights (fork, UI144): rank review items by how much they deserve a look.
 *
 * The Review page lists everything in time order, so finding the one visit
 * that mattered means scanning a timeline. Spotlights scores each review item
 * by the signals Frigate already stores on it (severity, review state, known
 * faces and plates, the GenAI threat level, notable sounds, loitering zones)
 * and lists the ones with at least one strong signal, best first.
 *
 * Repeats of one subject are folded into one card (`groupSpotlights`): the
 * same tracked object across review items, or the same known name on one
 * camera within half an hour. A person who stands on the walkway all evening
 * is one card with a count, not ninety cards.
 *
 * Everything here is pure so the page stays a thin view and the ranking is
 * unit tested. Each reason carries what its chip needs to explain it
 * ("Known face: Alice", "Plate ABC123", "Glass break").
 */

import type { ReviewSegment } from "@/types/review";

export const SPOTLIGHT_RANGES = ["24h", "3d", "7d"] as const;
export type SpotlightRange = (typeof SPOTLIGHT_RANGES)[number];

const HOUR = 60 * 60;
export const RANGE_SECONDS: Readonly<Record<SpotlightRange, number>> = {
  "24h": 24 * HOUR,
  "3d": 3 * 24 * HOUR,
  "7d": 7 * 24 * HOUR,
};

/** The range named in the URL, or the last 24 hours. */
export function parseSpotlightRange(
  value: string | null | undefined,
): SpotlightRange {
  return SPOTLIGHT_RANGES.find((range) => range === value) ?? "24h";
}

/**
 * Sounds that justify a look on their own: breaking glass, alarms that mean
 * smoke or fire, gunfire, screaming. Labels are the audio model's
 * (`audio-labelmap.txt`).
 */
export const CRITICAL_AUDIO: ReadonlySet<string> = new Set([
  "glass",
  "shatter",
  "breaking",
  "gunshot",
  "explosion",
  "scream",
  "smoke_detector",
  "fire_alarm",
]);

/** Sounds worth a chip and a lift, but common enough to rank lower. */
export const NOTABLE_AUDIO: ReadonlySet<string> = new Set([
  "siren",
  "civil_defense_siren",
  "car_alarm",
  "alarm",
  "yell",
]);

/** Object labels that count as vehicles for the "Vehicles" group. */
export const VEHICLE_LABELS: ReadonlySet<string> = new Set([
  "car",
  "motorcycle",
  "truck",
  "bus",
  "boat",
  "license_plate",
]);

export type SpotlightReason =
  | { kind: "threat"; level: number }
  | { kind: "audio"; label: string; critical: boolean }
  | { kind: "face"; name: string }
  | { kind: "knownPlate"; name: string }
  | { kind: "plate"; plate: string }
  | { kind: "identified"; name: string }
  | { kind: "loitering"; zone: string }
  | { kind: "alert" }
  | { kind: "unreviewed" };

export type SpotlightReasonKind = SpotlightReason["kind"];

/**
 * Reasons that put an item in the feed by themselves. The rest only add a
 * chip and lift the score: an unreviewed detection with nothing else going
 * for it, or an unknown plate on a street camera, would flood the feed.
 */
const HIGHLIGHT_KINDS: ReadonlySet<SpotlightReasonKind> = new Set([
  "threat",
  "audio",
  "face",
  "knownPlate",
  "loitering",
  "alert",
]);

/** How much one reason lifts an item. Each kind counts once. */
export function reasonWeight(reason: SpotlightReason): number {
  switch (reason.kind) {
    case "threat":
      return reason.level >= 2 ? 60 : 30;
    case "audio":
      return reason.critical ? 50 : 25;
    case "face":
      return 40;
    case "knownPlate":
      return 35;
    case "loitering":
      return 25;
    case "unreviewed":
      return 25;
    case "alert":
      return 20;
    case "identified":
      return 15;
    case "plate":
      return 10;
  }
}

export type SpotlightCategory =
  "people" | "vehicles" | "threats" | "unreviewed";

export const SPOTLIGHT_CATEGORIES: readonly SpotlightCategory[] = [
  "people",
  "vehicles",
  "threats",
  "unreviewed",
];

export function parseSpotlightCategory(
  value: string | null | undefined,
): SpotlightCategory | undefined {
  return SPOTLIGHT_CATEGORIES.find((category) => category === value);
}

export type SpotlightContext = {
  /** Names configured under `lpr.known_plates`. */
  knownPlateNames: ReadonlySet<string>;
  /** Face recognition is on, so a person's sub label is a known face. */
  faceRecognition: boolean;
  /** Tracked object id to its recognized plate. */
  plates: ReadonlyMap<string, string>;
  /** Camera to the zones that have a loitering time. */
  loiteringZones: Readonly<Partial<Record<string, ReadonlySet<string>>>>;
};

export const EMPTY_CONTEXT: SpotlightContext = {
  knownPlateNames: new Set(),
  faceRecognition: false,
  plates: new Map(),
  loiteringZones: {},
};

export type SpotlightItem = {
  review: ReviewSegment;
  /** Strongest first. */
  reasons: SpotlightReason[];
  score: number;
  categories: SpotlightCategory[];
};

export type SpotlightFeed = {
  /** Best first. */
  items: SpotlightItem[];
  /** Items in the window with no strong signal, left out of the feed. */
  hidden: number;
};

/** "person-verified" and "person" are the same object for ranking. */
function baseLabel(label: string): string {
  return label.replace("-verified", "");
}

/** Every reason this item deserves a look, strongest first. */
export function spotlightReasons(
  review: ReviewSegment,
  context: SpotlightContext,
): SpotlightReason[] {
  const reasons: SpotlightReason[] = [];
  const data = review.data;

  const level = data.metadata?.potential_threat_level ?? 0;
  if (level >= 1) {
    reasons.push({ kind: "threat", level });
  }

  for (const label of new Set(data.audio)) {
    if (CRITICAL_AUDIO.has(label)) {
      reasons.push({ kind: "audio", label, critical: true });
    } else if (NOTABLE_AUDIO.has(label)) {
      reasons.push({ kind: "audio", label, critical: false });
    }
  }

  // Review items keep sub labels by name only, without the object they
  // belong to. A known plate's name is in the LPR config; otherwise, with
  // face recognition on and a person in the item, the name is a face.
  const objects = new Set(data.objects.map(baseLabel));
  for (const name of new Set(data.sub_labels ?? [])) {
    if (context.knownPlateNames.has(name)) {
      reasons.push({ kind: "knownPlate", name });
    } else if (context.faceRecognition && objects.has("person")) {
      reasons.push({ kind: "face", name });
    } else {
      reasons.push({ kind: "identified", name });
    }
  }

  const plates = new Set<string>();
  for (const id of data.detections) {
    const plate = context.plates.get(id);
    if (plate) {
      plates.add(plate);
    }
  }
  for (const plate of plates) {
    reasons.push({ kind: "plate", plate });
  }

  // A zone with a loitering time only counts an object as in it once the
  // object has stayed that long, so the zone being listed means it loitered.
  const loitering = context.loiteringZones[review.camera];
  for (const zone of new Set(data.zones)) {
    if (loitering?.has(zone)) {
      reasons.push({ kind: "loitering", zone });
    }
  }

  if (review.severity === "alert") {
    reasons.push({ kind: "alert" });
  }
  if (!review.has_been_reviewed) {
    reasons.push({ kind: "unreviewed" });
  }

  // stable sort keeps the push order for reasons of equal weight
  return reasons
    .map((reason, index) => ({ reason, index }))
    .sort(
      (a, b) =>
        reasonWeight(b.reason) - reasonWeight(a.reason) || a.index - b.index,
    )
    .map(({ reason }) => reason);
}

/** The best weight of each reason kind, added up. */
export function scoreReasons(reasons: readonly SpotlightReason[]): number {
  const best = new Map<SpotlightReasonKind, number>();
  for (const reason of reasons) {
    best.set(
      reason.kind,
      Math.max(best.get(reason.kind) ?? 0, reasonWeight(reason)),
    );
  }
  let total = 0;
  for (const weight of best.values()) {
    total += weight;
  }
  return total;
}

/** True when at least one reason is strong enough to list the item. */
export function isSpotlight(reasons: readonly SpotlightReason[]): boolean {
  return reasons.some((reason) => HIGHLIGHT_KINDS.has(reason.kind));
}

/** The grouping chips an item shows up under. */
export function spotlightCategories(
  review: ReviewSegment,
  reasons: readonly SpotlightReason[],
): SpotlightCategory[] {
  const kinds = new Set(reasons.map((reason) => reason.kind));
  const categories: SpotlightCategory[] = [];
  if (kinds.has("face")) {
    categories.push("people");
  }
  // a person alert with a passing car is about the person, so only a plate
  // or an item that is nothing but vehicles counts as a vehicle
  const objects = review.data.objects.map(baseLabel);
  if (
    kinds.has("knownPlate") ||
    kinds.has("plate") ||
    (objects.length > 0 && objects.every((label) => VEHICLE_LABELS.has(label)))
  ) {
    categories.push("vehicles");
  }
  if (kinds.has("threat") || kinds.has("audio") || kinds.has("loitering")) {
    categories.push("threats");
  }
  if (review.severity === "alert" && kinds.has("unreviewed")) {
    categories.push("unreviewed");
  }
  return categories;
}

export type SpotlightWindow = {
  /** Unix seconds; items that ended before it are out of range. */
  after: number;
  /** Only these cameras, or every camera when undefined. */
  cameras?: readonly string[] | undefined;
};

/**
 * Mirrors the `/review` query the page sends (`after`, `cameras`), so the
 * feed stays right when a response holds more than was asked for.
 */
export function inSpotlightWindow(
  review: ReviewSegment,
  window: SpotlightWindow,
): boolean {
  if (window.cameras && !window.cameras.includes(review.camera)) {
    return false;
  }
  return review.end_time == undefined || review.end_time > window.after;
}

/** Score every review item and list the ones worth a look, best first. */
export function rankSpotlights(
  reviews: readonly ReviewSegment[],
  context: SpotlightContext,
  window?: SpotlightWindow,
): SpotlightFeed {
  const items: SpotlightItem[] = [];
  let hidden = 0;
  for (const review of reviews) {
    // motion-only items carry no labels to rank by
    if (review.severity === "significant_motion") {
      continue;
    }
    if (window && !inSpotlightWindow(review, window)) {
      continue;
    }
    const reasons = spotlightReasons(review, context);
    if (!isSpotlight(reasons)) {
      hidden += 1;
      continue;
    }
    items.push({
      review,
      reasons,
      score: scoreReasons(reasons),
      categories: spotlightCategories(review, reasons),
    });
  }
  items.sort(
    (a, b) =>
      b.score - a.score ||
      b.review.start_time - a.review.start_time ||
      a.review.id.localeCompare(b.review.id),
  );
  return { items, hidden };
}

/**
 * The review state this page set, over what the server last said. The page
 * keeps its cards in place between refreshes (`pinFeed`), so an item marked
 * reviewed changes its chips where it is instead of moving.
 */
export function withReviewState(
  reviews: readonly ReviewSegment[],
  states: ReadonlyMap<string, boolean>,
): ReviewSegment[] {
  if (states.size === 0) {
    return [...reviews];
  }
  return reviews.map((review) => {
    const reviewed = states.get(review.id);
    return reviewed === undefined || reviewed === review.has_been_reviewed
      ? review
      : { ...review, has_been_reviewed: reviewed };
  });
}

/**
 * The reasons a card shows as chips. "Unreviewed" is the card's dot and
 * border instead, and "Alert" only shows when it is why the item is listed:
 * next to "Known face: Alice" it would only bury the reason that ranked it.
 */
export function cardReasons(
  reasons: readonly SpotlightReason[],
): SpotlightReason[] {
  const shown = reasons.filter((reason) => reason.kind !== "unreviewed");
  const stronger = shown.some(
    (reason) => reason.kind !== "alert" && HIGHLIGHT_KINDS.has(reason.kind),
  );
  return stronger ? shown.filter((reason) => reason.kind !== "alert") : shown;
}

/** True while the item still has its "unreviewed" lift. */
export function isUnreviewed(item: SpotlightItem): boolean {
  return item.reasons.some((reason) => reason.kind === "unreviewed");
}

/** Two sightings of one name on a camera this close are one visit. */
export const REPEAT_GAP_SECONDS = 30 * 60;

export type SpotlightGroup = {
  /** The best ranked member; the card shows it. */
  lead: SpotlightItem;
  /** The other members, newest first. */
  others: SpotlightItem[];
};

/** The names an item was identified by: faces, known plates, sub labels. */
function identityNames(item: SpotlightItem): string[] {
  const names: string[] = [];
  for (const reason of item.reasons) {
    if (
      reason.kind === "face" ||
      reason.kind === "knownPlate" ||
      reason.kind === "identified"
    ) {
      names.push(reason.name);
    }
  }
  return names;
}

/**
 * Fold repeats of one subject into one group so it cannot crowd out
 * everything else: items that share a tracked object, and items on one camera
 * with the same known name that start within `REPEAT_GAP_SECONDS` of the
 * previous one ending. `items` must be best first; each group is led by its
 * best member and the groups keep that order.
 */
export function groupSpotlights(
  items: readonly SpotlightItem[],
): SpotlightGroup[] {
  // union-find over positions; the lower position wins, so every root is
  // the best ranked member of its group
  const parent = items.map((_, index) => index);
  const parentOf = (index: number) => parent[index] ?? index;
  const find = (index: number): number => {
    let root = index;
    while (parentOf(root) !== root) {
      root = parentOf(root);
    }
    let node = index;
    while (node !== root) {
      const next = parentOf(node);
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    }
  };

  type Sighting = { index: number; review: ReviewSegment };
  const byObject = new Map<string, number>();
  const byName = new Map<string, Sighting[]>();
  items.forEach((item, index) => {
    for (const id of item.review.data.detections) {
      const first = byObject.get(id);
      if (first === undefined) {
        byObject.set(id, index);
      } else {
        union(first, index);
      }
    }
    for (const name of identityNames(item)) {
      // camera names cannot hold a slash
      const key = `${item.review.camera}/${name}`;
      const list = byName.get(key) ?? [];
      list.push({ index, review: item.review });
      byName.set(key, list);
    }
  });

  for (const sightings of byName.values()) {
    const ordered = [...sightings].sort(
      (a, b) => a.review.start_time - b.review.start_time,
    );
    // how far the current run of sightings reaches; one still in progress
    // has not ended, so whatever comes next is in reach
    let reach = -Infinity;
    let previous: number | undefined;
    for (const { index, review } of ordered) {
      if (
        previous !== undefined &&
        review.start_time - reach <= REPEAT_GAP_SECONDS
      ) {
        union(previous, index);
      } else {
        reach = -Infinity;
      }
      reach = Math.max(reach, review.end_time ?? Infinity);
      previous = index;
    }
  }

  // Items arrive best first, so the first one seen for a root leads its group.
  const groups = new Map<number, SpotlightGroup>();
  items.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) {
      group.others.push(item);
    } else {
      groups.set(root, { lead: item, others: [] });
    }
  });
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => {
      group.others.sort((a, b) => b.review.start_time - a.review.start_time);
      return group;
    });
}

/** Every review item in a group, best first. */
export function groupMembers(group: SpotlightGroup): SpotlightItem[] {
  return [group.lead, ...group.others];
}

/** The items in one grouping chip, or all of them. */
export function inCategory(
  items: readonly SpotlightItem[],
  category: SpotlightCategory | undefined,
): SpotlightItem[] {
  return category
    ? items.filter((item) => item.categories.includes(category))
    : [...items];
}

/**
 * How many cards each grouping chip shows. Repeats are grouped within the
 * chip, so each count is the number of cards selecting that chip lists.
 */
export function countGroups(
  items: readonly SpotlightItem[],
): Record<SpotlightCategory | "all", number> {
  const counts = { all: groupSpotlights(items).length } as Record<
    SpotlightCategory | "all",
    number
  >;
  for (const category of SPOTLIGHT_CATEGORIES) {
    counts[category] = groupSpotlights(inCategory(items, category)).length;
  }
  return counts;
}

/**
 * The grouping chips worth showing. "Unreviewed alerts" says nothing new
 * when it holds every card, as on a day nobody has reviewed yet, so it hides
 * then unless it is the one selected.
 */
export function shownCategories(
  counts: Readonly<Record<SpotlightCategory | "all", number>>,
  selected: SpotlightCategory | undefined,
): SpotlightCategory[] {
  return SPOTLIGHT_CATEGORIES.filter(
    (category) =>
      category !== "unreviewed" ||
      selected === "unreviewed" ||
      counts.unreviewed !== counts.all,
  );
}

/** Cards rendered per page; divisible by the 1, 2, 3 and 4 column grids. */
export const PAGE_SIZE = 24;

/** The names under `lpr.known_plates`. */
export function knownPlateNames(
  knownPlates: Readonly<Record<string, unknown>> | null | undefined,
): Set<string> {
  return new Set(Object.keys(knownPlates ?? {}));
}

type ZoneConfigLike = { loitering_time?: number | null };
type CameraConfigLike = { zones?: Readonly<Record<string, ZoneConfigLike>> };

/** For each camera, the zones with a loitering time. */
export function loiteringZoneMap(
  cameras: Readonly<Record<string, CameraConfigLike>> | undefined,
): Record<string, Set<string>> {
  const result: Record<string, Set<string>> = {};
  for (const [camera, config] of Object.entries(cameras ?? {})) {
    const zones = Object.entries(config.zones ?? {})
      .filter(([, zone]) => (zone.loitering_time ?? 0) > 0)
      .map(([name]) => name);
    if (zones.length > 0) {
      result[camera] = new Set(zones);
    }
  }
  return result;
}

type EventLike = {
  id: string;
  data?: { recognized_license_plate?: unknown } | null;
};

/** Tracked object id to its recognized plate, for the objects that have one. */
export function platesByEvent(
  events: readonly EventLike[] | undefined,
): Map<string, string> {
  const plates = new Map<string, string>();
  for (const event of events ?? []) {
    const plate = event.data?.recognized_license_plate;
    if (typeof plate === "string" && plate.trim()) {
      plates.set(event.id, plate.trim());
    }
  }
  return plates;
}
