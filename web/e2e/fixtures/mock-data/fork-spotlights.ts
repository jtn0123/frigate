/**
 * A realistic day for the Spotlights page (UI144).
 *
 * A GenAI threat, glass breaking, known faces, a known car, a plate on an
 * alert, a loiterer and a siren rank first. A cat, a passerby and a parked
 * car are ordinary detections the page counts and leaves to Review, and one
 * alert from yesterday only shows up in the longer ranges.
 */

export const SPOTLIGHT_KNOWN_PLATE = "Bob's Tesla";

export type SpotlightReviewMock = {
  id: string;
  camera: string;
  start_time: number;
  end_time: number | null;
  has_been_reviewed: boolean;
  severity: "alert" | "detection";
  thumb_path: string;
  data: {
    audio: string[];
    detections: string[];
    objects: string[];
    sub_labels: string[];
    significant_motion_areas: number[];
    zones: string[];
    metadata?: {
      title: string;
      scene: string;
      confidence: number;
      potential_threat_level?: number;
      other_concerns?: string[];
    };
  };
};

type ReviewSpec = {
  camera: string;
  minutesAgo: number;
  severity?: "alert" | "detection";
  reviewed?: boolean;
  data?: Partial<SpotlightReviewMock["data"]>;
};

function review(
  now: number,
  id: string,
  spec: ReviewSpec,
): SpotlightReviewMock {
  const start = now - spec.minutesAgo * 60;
  return {
    id,
    camera: spec.camera,
    start_time: start,
    end_time: start + 42,
    has_been_reviewed: spec.reviewed ?? false,
    severity: spec.severity ?? "detection",
    thumb_path: `/media/frigate/clips/review/thumb-${spec.camera}-${id}.webp`,
    data: {
      audio: [],
      detections: [`ev-${id}`],
      objects: [],
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
      ...spec.data,
    },
  };
}

/** The ids in the order the 24 hour feed ranks them. */
export const SPOTLIGHT_ORDER = [
  "threat",
  "glass",
  "alice",
  "bob-car",
  "plate",
  "loiter",
  "siren",
  "bob-face",
] as const;

/** Ordinary detections in the last day, left out of the feed. */
export const SPOTLIGHT_HIDDEN = 3;

export function spotlightReviews(now: number): SpotlightReviewMock[] {
  return [
    review(now, "threat", {
      camera: "backyard",
      minutesAgo: 25,
      severity: "alert",
      data: {
        objects: ["person"],
        zones: ["lawn"],
        metadata: {
          title: "Person tries the back gate",
          scene:
            "A person in a dark jacket follows the fence line, stops at the back gate and pulls the latch twice, then walks off toward the alley.",
          confidence: 0.87,
          potential_threat_level: 2,
        },
      },
    }),
    review(now, "cat", {
      camera: "backyard",
      minutesAgo: 50,
      data: { objects: ["cat"] },
    }),
    review(now, "glass", {
      camera: "garage",
      minutesAgo: 70,
      severity: "alert",
      data: { audio: ["glass"] },
    }),
    review(now, "alice", {
      camera: "front_door",
      minutesAgo: 120,
      severity: "alert",
      data: {
        objects: ["person"],
        sub_labels: ["Alice"],
        zones: ["porch"],
      },
    }),
    review(now, "bob-car", {
      camera: "garage",
      minutesAgo: 180,
      data: {
        objects: ["car"],
        sub_labels: [SPOTLIGHT_KNOWN_PLATE],
        zones: ["driveway"],
      },
    }),
    review(now, "walker", {
      camera: "front_door",
      minutesAgo: 210,
      data: { objects: ["person"], zones: ["front_yard"] },
    }),
    review(now, "plate", {
      camera: "garage",
      minutesAgo: 240,
      severity: "alert",
      data: { objects: ["car"], zones: ["driveway"] },
    }),
    review(now, "loiter", {
      camera: "backyard",
      minutesAgo: 300,
      data: { objects: ["person"], zones: ["lawn", "back_gate"] },
    }),
    review(now, "siren", {
      camera: "backyard",
      minutesAgo: 360,
      data: { audio: ["siren"] },
    }),
    review(now, "parked", {
      camera: "garage",
      minutesAgo: 420,
      data: { objects: ["car"], zones: ["driveway"] },
    }),
    review(now, "bob-face", {
      camera: "backyard",
      minutesAgo: 480,
      reviewed: true,
      data: { objects: ["person"], sub_labels: ["Bob"] },
    }),
    review(now, "yesterday", {
      camera: "front_door",
      minutesAgo: 30 * 60,
      severity: "alert",
      data: { objects: ["person"], zones: ["porch"] },
    }),
  ];
}

/** Repeats of one person in `spotlightRepeats`, on the backyard camera. */
export const SPOTLIGHT_REPEATS = 90;

/**
 * One person tracked all afternoon: an alert every two minutes, each with
 * the same tracked object and the same known face. They belong on one card.
 */
export function spotlightRepeats(
  now: number,
  count = SPOTLIGHT_REPEATS,
): SpotlightReviewMock[] {
  return Array.from({ length: count }, (_, index) =>
    review(now, `repeat-${index}`, {
      camera: "backyard",
      minutesAgo: 2 + index * 2,
      severity: "alert",
      data: {
        objects: ["person"],
        sub_labels: ["Alice"],
        detections: ["ev-backyard-alice"],
      },
    }),
  );
}

/**
 * A busy street: person alerts that a car happens to pass through. Each is
 * its own visit, ranks below everything with a real reason, and is not a
 * vehicle sighting.
 */
export function spotlightStreet(
  now: number,
  count: number,
): SpotlightReviewMock[] {
  return Array.from({ length: count }, (_, index) =>
    review(now, `street-${index}`, {
      camera: "garage",
      minutesAgo: 5 + index * 3,
      severity: "alert",
      data: {
        objects: ["person", "car"],
        detections: [`ev-street-person-${index}`, `ev-street-car-${index}`],
        zones: ["driveway"],
      },
    }),
  );
}

/** The tracked objects with a recognized plate, as `/events` returns them. */
export function spotlightPlateEvents(now: number) {
  const event = (id: string, plate: string, minutesAgo: number) => ({
    id: `ev-${id}`,
    label: "car",
    sub_label: null,
    camera: "garage",
    start_time: now - minutesAgo * 60,
    end_time: now - minutesAgo * 60 + 42,
    false_positive: false,
    zones: ["driveway"],
    thumbnail: null,
    has_clip: true,
    has_snapshot: true,
    retain_indefinitely: false,
    plus_id: null,
    model_hash: "abc123",
    detector_type: "cpu",
    model_type: "ssd",
    data: {
      top_score: 0.91,
      score: 0.91,
      type: "object",
      recognized_license_plate: plate,
      recognized_license_plate_score: 0.94,
    },
  });
  return [event("bob-car", "7KLM482", 180), event("plate", "ABC123", 240)];
}

function zone(friendlyName: string, loiteringTime: number) {
  return {
    friendly_name: friendlyName,
    coordinates: "0.1,0.1,0.5,0.1,0.5,0.5,0.1,0.5",
    enabled: true,
    enabled_in_config: true,
    filters: {},
    inertia: 3,
    loitering_time: loiteringTime,
    objects: [],
    distances: [],
    color: [0, 255, 0],
  };
}

/** Face recognition, plates with one known car, and a gate to loiter at. */
export function spotlightsConfig() {
  return {
    face_recognition: { enabled: true },
    lpr: {
      enabled: true,
      known_plates: { [SPOTLIGHT_KNOWN_PLATE]: ["7KLM482"] },
    },
    semantic_search: { enabled: true },
    cameras: {
      front_door: {
        zones: {
          front_yard: zone("Front yard", 0),
          porch: zone("Front porch", 0),
        },
      },
      backyard: {
        zones: {
          lawn: zone("Lawn", 0),
          back_gate: zone("Back gate", 20),
        },
      },
      garage: { zones: { driveway: zone("Driveway", 0) } },
    },
  };
}
