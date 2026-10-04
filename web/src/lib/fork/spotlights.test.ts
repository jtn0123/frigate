import { describe, expect, it } from "vitest";
import type { ReviewData, ReviewSegment } from "@/types/review";
import {
  EMPTY_CONTEXT,
  REPEAT_GAP_SECONDS,
  cardReasons,
  countGroups,
  groupMembers,
  groupSpotlights,
  inCategory,
  inSpotlightWindow,
  isSpotlight,
  isUnreviewed,
  knownPlateNames,
  loiteringZoneMap,
  parseSpotlightCategory,
  parseSpotlightRange,
  platesByEvent,
  rankSpotlights,
  reasonWeight,
  scoreReasons,
  shownCategories,
  spotlightCategories,
  spotlightReasons,
  withReviewState,
  type SpotlightContext,
  type SpotlightGroup,
} from "./spotlights";

const NOW = 1_790_000_000;

function review(
  id: string,
  overrides: Partial<Omit<ReviewSegment, "data">> & {
    data?: Partial<ReviewData>;
  } = {},
): ReviewSegment {
  const { data, ...rest } = overrides;
  return {
    id,
    camera: "front_door",
    severity: "detection",
    start_time: NOW - 600,
    end_time: NOW - 570,
    thumb_path: `/media/frigate/clips/review/thumb-${id}.webp`,
    has_been_reviewed: true,
    ...rest,
    data: {
      audio: [],
      detections: [`${id}-obj`],
      objects: ["person"],
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
      ...data,
    },
  };
}

function first<T>(list: readonly T[]): T {
  const [item] = list;
  if (item === undefined) {
    throw new Error("expected at least one item");
  }
  return item;
}

const CONTEXT: SpotlightContext = {
  knownPlateNames: new Set(["Bob's Tesla"]),
  faceRecognition: true,
  plates: new Map([["car-1", "ABC123"]]),
  loiteringZones: { front_door: new Set(["porch"]) },
};

describe("parse helpers", () => {
  it("falls back to the last 24 hours", () => {
    expect(parseSpotlightRange("7d")).toBe("7d");
    expect(parseSpotlightRange("3d")).toBe("3d");
    expect(parseSpotlightRange("1y")).toBe("24h");
    expect(parseSpotlightRange(null)).toBe("24h");
  });

  it("accepts only known categories", () => {
    expect(parseSpotlightCategory("people")).toBe("people");
    expect(parseSpotlightCategory("everything")).toBeUndefined();
    expect(parseSpotlightCategory(undefined)).toBeUndefined();
  });
});

describe("spotlightReasons", () => {
  it("names a known face, strongest reason first", () => {
    const reasons = spotlightReasons(
      review("r1", {
        severity: "alert",
        has_been_reviewed: false,
        data: { sub_labels: ["Alice"] },
      }),
      CONTEXT,
    );
    expect(reasons).toEqual([
      { kind: "face", name: "Alice" },
      { kind: "unreviewed" },
      { kind: "alert" },
    ]);
  });

  it("tells a known plate from a face by the LPR config", () => {
    const reasons = spotlightReasons(
      review("r1", {
        data: {
          objects: ["car"],
          sub_labels: ["Bob's Tesla"],
          detections: ["car-1"],
        },
      }),
      CONTEXT,
    );
    expect(reasons).toEqual([
      { kind: "knownPlate", name: "Bob's Tesla" },
      { kind: "plate", plate: "ABC123" },
    ]);
  });

  it("calls a sub label identified when it cannot be a face", () => {
    expect(
      spotlightReasons(
        review("r1", { data: { objects: ["bird"], sub_labels: ["Blue Jay"] } }),
        CONTEXT,
      ),
    ).toEqual([{ kind: "identified", name: "Blue Jay" }]);
    expect(
      spotlightReasons(review("r2", { data: { sub_labels: ["Alice"] } }), {
        ...CONTEXT,
        faceRecognition: false,
      }),
    ).toEqual([{ kind: "identified", name: "Alice" }]);
  });

  it("reads verified labels as the base object", () => {
    expect(
      spotlightReasons(
        review("r1", {
          data: { objects: ["person-verified"], sub_labels: ["Alice"] },
        }),
        CONTEXT,
      ),
    ).toEqual([{ kind: "face", name: "Alice" }]);
  });

  it("lifts the GenAI threat level, notable sounds and loitering", () => {
    const reasons = spotlightReasons(
      review("r1", {
        data: {
          audio: ["glass", "siren", "speech"],
          zones: ["porch", "driveway"],
          metadata: {
            title: "Person tries the side door",
            scene: "A person tries the handle.",
            confidence: 0.9,
            potential_threat_level: 2,
          },
        },
      }),
      CONTEXT,
    );
    expect(reasons).toEqual([
      { kind: "threat", level: 2 },
      { kind: "audio", label: "glass", critical: true },
      { kind: "audio", label: "siren", critical: false },
      { kind: "loitering", zone: "porch" },
    ]);
  });

  it("ignores threat level 0 and unlisted sounds", () => {
    expect(
      spotlightReasons(
        review("r1", {
          data: {
            audio: ["speech", "bark"],
            metadata: {
              title: "Dog in the yard",
              scene: "",
              confidence: 0.8,
              potential_threat_level: 0,
            },
          },
        }),
        CONTEXT,
      ),
    ).toEqual([]);
  });

  it("lists each plate and name once", () => {
    const reasons = spotlightReasons(
      review("r1", {
        data: {
          objects: ["car", "car"],
          sub_labels: ["Alice", "Alice"],
          detections: ["car-1", "car-2"],
        },
      }),
      {
        ...CONTEXT,
        plates: new Map([
          ["car-1", "XYZ"],
          ["car-2", "XYZ"],
        ]),
      },
    );
    expect(reasons.filter((reason) => reason.kind === "plate")).toHaveLength(1);
    expect(
      reasons.filter((reason) => reason.kind === "identified"),
    ).toHaveLength(1);
  });
});

describe("scoring", () => {
  it("weights a security concern above everything else", () => {
    expect(reasonWeight({ kind: "threat", level: 2 })).toBeGreaterThan(
      reasonWeight({ kind: "audio", label: "glass", critical: true }),
    );
    expect(reasonWeight({ kind: "threat", level: 1 })).toBeLessThan(
      reasonWeight({ kind: "face", name: "Alice" }),
    );
  });

  it("counts each kind once", () => {
    expect(
      scoreReasons([
        { kind: "face", name: "Alice" },
        { kind: "face", name: "Bob" },
        { kind: "alert" },
      ]),
    ).toBe(60);
  });

  it("needs one strong reason to list an item", () => {
    expect(isSpotlight([{ kind: "unreviewed" }])).toBe(false);
    expect(isSpotlight([{ kind: "plate", plate: "ABC123" }])).toBe(false);
    expect(isSpotlight([{ kind: "identified", name: "Blue Jay" }])).toBe(false);
    expect(isSpotlight([{ kind: "alert" }])).toBe(true);
    expect(isSpotlight([{ kind: "loitering", zone: "porch" }])).toBe(true);
  });
});

describe("spotlightCategories", () => {
  it("groups known faces, vehicles, threats and unreviewed alerts", () => {
    const alert = review("r1", {
      severity: "alert",
      has_been_reviewed: false,
      data: { objects: ["person"], sub_labels: ["Alice"] },
    });
    expect(
      spotlightCategories(alert, spotlightReasons(alert, CONTEXT)),
    ).toEqual(["people", "unreviewed"]);

    const glass = review("r2", { data: { objects: [], audio: ["glass"] } });
    expect(
      spotlightCategories(glass, spotlightReasons(glass, CONTEXT)),
    ).toEqual(["threats"]);
  });

  it("counts a vehicle only by its plate or when vehicles are all there is", () => {
    const categories = (data: Parameters<typeof review>[1]) => {
      const item = review("r1", { severity: "alert", ...data });
      return spotlightCategories(item, spotlightReasons(item, CONTEXT));
    };
    // a person alert with a passing car is about the person
    expect(categories({ data: { objects: ["person", "car"] } })).toEqual([]);
    expect(categories({ data: { objects: ["car", "truck"] } })).toEqual([
      "vehicles",
    ]);
    expect(categories({ data: { objects: ["car-verified"] } })).toEqual([
      "vehicles",
    ]);
    // a recognized plate makes it about the vehicle even with a person
    expect(
      categories({
        data: { objects: ["person", "car"], detections: ["car-1"] },
      }),
    ).toEqual(["vehicles"]);
    expect(
      categories({
        data: { objects: ["person", "car"], sub_labels: ["Bob's Tesla"] },
      }),
    ).toEqual(["vehicles"]);
    // a sound alone is not a vehicle
    expect(categories({ data: { objects: [], audio: ["speech"] } })).toEqual(
      [],
    );
  });

  it("does not call a reviewed alert unreviewed", () => {
    const alert = review("r1", { severity: "alert" });
    expect(
      spotlightCategories(alert, spotlightReasons(alert, CONTEXT)),
    ).toEqual([]);
  });
});

describe("rankSpotlights", () => {
  const reviews = [
    review("ordinary-detection"),
    review("unreviewed-detection", { has_been_reviewed: false }),
    review("old-alert", { severity: "alert", start_time: NOW - 9000 }),
    review("new-alert", { severity: "alert", start_time: NOW - 100 }),
    review("glass", {
      severity: "alert",
      has_been_reviewed: false,
      data: { objects: [], audio: ["glass"] },
    }),
    review("alice", { data: { sub_labels: ["Alice"] } }),
    review("threat", {
      severity: "alert",
      has_been_reviewed: false,
      data: {
        metadata: {
          title: "Person tries the side door",
          scene: "",
          confidence: 0.9,
          potential_threat_level: 2,
        },
      },
    }),
    review("motion", { severity: "significant_motion" }),
  ];

  it("lists strong signals first and counts what it left out", () => {
    const feed = rankSpotlights(reviews, CONTEXT);
    expect(feed.items.map((item) => item.review.id)).toEqual([
      "threat",
      "glass",
      "alice",
      "new-alert",
      "old-alert",
    ]);
    expect(feed.hidden).toBe(2);
    expect(feed.items.at(0)?.score).toBe(105);
  });

  it("keeps to the requested window and cameras", () => {
    const inProgress = review("in-progress", { severity: "alert" });
    delete inProgress.end_time;
    const feed = rankSpotlights(
      [
        review("ended-before", {
          severity: "alert",
          end_time: NOW - 5000,
        }),
        inProgress,
        review("other-camera", { severity: "alert", camera: "garage" }),
        review("inside", { severity: "alert" }),
      ],
      EMPTY_CONTEXT,
      { after: NOW - 3600, cameras: ["front_door"] },
    );
    expect(feed.items.map((item) => item.review.id).sort()).toEqual([
      "in-progress",
      "inside",
    ]);
  });

  it("breaks ties by recency, then id", () => {
    const feed = rankSpotlights(
      [
        review("b", { severity: "alert", start_time: NOW - 50 }),
        review("a", { severity: "alert", start_time: NOW - 50 }),
        review("c", { severity: "alert", start_time: NOW - 10 }),
      ],
      EMPTY_CONTEXT,
    );
    expect(feed.items.map((item) => item.review.id)).toEqual(["c", "a", "b"]);
  });
});

describe("withReviewState", () => {
  it("applies the state this page set over the server copy", () => {
    const unreviewed = review("a", { has_been_reviewed: false });
    const reviewed = review("b", { has_been_reviewed: true });
    const untouched = review("c", { has_been_reviewed: false });
    const result = withReviewState(
      [unreviewed, reviewed, untouched],
      new Map([
        ["a", true],
        ["b", false],
      ]),
    );
    expect(result.map((item) => item.has_been_reviewed)).toEqual([
      true,
      false,
      false,
    ]);
    // copies, so the server copy keeps what the server said
    expect(unreviewed.has_been_reviewed).toBe(false);
    expect(result.at(2)).toBe(untouched);
  });

  it("drops the unreviewed lift once marked, and adds it back on undo", () => {
    const alert = review("a", { severity: "alert", has_been_reviewed: false });
    const marked = first(
      rankSpotlights(withReviewState([alert], new Map([["a", true]])), CONTEXT)
        .items,
    );
    expect(isUnreviewed(marked)).toBe(false);
    expect(marked.categories).toEqual([]);
    const undone = first(
      rankSpotlights(withReviewState([alert], new Map([["a", false]])), CONTEXT)
        .items,
    );
    expect(isUnreviewed(undone)).toBe(true);
    expect(undone.categories).toEqual(["unreviewed"]);
  });

  it("keeps a review object the state already matches", () => {
    // the preview player sets the flag on the shared object before the page
    // posts it, so the matching state must not copy it back to unreviewed
    const watched = review("a", { has_been_reviewed: true });
    expect(withReviewState([watched], new Map([["a", true]])).at(0)).toBe(
      watched,
    );
    const none = [review("b")];
    expect(withReviewState(none, new Map())).not.toBe(none);
  });
});

describe("cardReasons", () => {
  it("leaves unreviewed to the card's dot and alert to the stronger reason", () => {
    expect(
      cardReasons([
        { kind: "face", name: "Alice" },
        { kind: "unreviewed" },
        { kind: "alert" },
      ]),
    ).toEqual([{ kind: "face", name: "Alice" }]);
  });

  it("keeps alert when it is why the item is listed", () => {
    expect(
      cardReasons([
        { kind: "unreviewed" },
        { kind: "alert" },
        { kind: "plate", plate: "ABC123" },
      ]),
    ).toEqual([{ kind: "alert" }, { kind: "plate", plate: "ABC123" }]);
    expect(cardReasons([{ kind: "alert" }])).toEqual([{ kind: "alert" }]);
  });
});

describe("groupSpotlights", () => {
  const ids = (groups: SpotlightGroup[]) =>
    groups.map((group) => groupMembers(group).map((item) => item.review.id));

  it("folds one tracked object seen over and over into one card", () => {
    // ninety two-minute alerts of one person who stood on the walkway
    const repeats = Array.from({ length: 90 }, (_, index) =>
      review(`alice-${index}`, {
        severity: "alert",
        has_been_reviewed: false,
        start_time: NOW - 120 * (index + 1),
        end_time: NOW - 120 * (index + 1) + 60,
        data: { sub_labels: ["Alice"], detections: ["walkway-person"] },
      }),
    );
    const others = [
      review("glass", { severity: "alert", data: { audio: ["glass"] } }),
      review("car", { severity: "alert", data: { objects: ["car"] } }),
    ];
    const groups = groupSpotlights(
      rankSpotlights([...repeats, ...others], CONTEXT).items,
    );
    expect(groups).toHaveLength(3);
    const alice = first(groups);
    // led by its best member (the newest of equals), the rest newest first
    expect(alice.lead.review.id).toBe("alice-0");
    expect(alice.others).toHaveLength(89);
    expect(alice.others.at(0)?.review.id).toBe("alice-1");
    expect(alice.others.at(-1)?.review.id).toBe("alice-89");
    expect(ids(groups).slice(1)).toEqual([["glass"], ["car"]]);
  });

  it("joins items that share any tracked object", () => {
    const groups = groupSpotlights(
      rankSpotlights(
        [
          review("a", {
            severity: "alert",
            start_time: NOW - 300,
            data: { detections: ["p1"] },
          }),
          review("b", {
            severity: "alert",
            start_time: NOW - 200,
            data: { detections: ["p1", "p2"] },
          }),
          review("c", {
            severity: "alert",
            start_time: NOW - 100,
            data: { detections: ["p2"] },
          }),
          review("d", { severity: "alert", data: { detections: ["p3"] } }),
        ],
        EMPTY_CONTEXT,
      ).items,
    );
    expect(groups.map((group) => group.others.length + 1).sort()).toEqual([
      1, 3,
    ]);
  });

  it("joins one name on one camera within the gap, and only then", () => {
    const sighting = (id: string, start: number, camera = "front_door") =>
      review(id, {
        camera,
        severity: "alert",
        start_time: start,
        end_time: start + 60,
        data: { sub_labels: ["Alice"] },
      });
    const groups = groupSpotlights(
      rankSpotlights(
        [
          sighting("morning", NOW - 10 * 3600),
          sighting("noon-1", NOW - 3 * 3600),
          // starts 29 minutes after noon-1 ended
          sighting("noon-2", NOW - 3 * 3600 + 60 + 29 * 60),
          // 31 minutes after noon-2 ended
          sighting("noon-3", NOW - 3 * 3600 + 120 + 60 + 29 * 60 + 31 * 60),
          sighting("garage", NOW - 3 * 3600 + 30, "garage"),
        ],
        CONTEXT,
      ).items,
    );
    expect(REPEAT_GAP_SECONDS).toBe(30 * 60);
    const sets = ids(groups).map((members) => [...members].sort());
    expect(sets).toContainEqual(["noon-1", "noon-2"]);
    expect(sets).toContainEqual(["morning"]);
    expect(sets).toContainEqual(["noon-3"]);
    expect(sets).toContainEqual(["garage"]);
  });

  it("keeps a sighting still in progress open to the next one", () => {
    const ongoing = review("ongoing", {
      severity: "alert",
      start_time: NOW - 5 * 3600,
      data: { sub_labels: ["Alice"] },
    });
    delete ongoing.end_time;
    const groups = groupSpotlights(
      rankSpotlights(
        [
          ongoing,
          review("later", {
            severity: "alert",
            start_time: NOW - 60,
            data: { sub_labels: ["Alice"] },
          }),
        ],
        CONTEXT,
      ).items,
    );
    expect(groups).toHaveLength(1);
  });

  it("ranks a group by its best member", () => {
    const groups = groupSpotlights(
      rankSpotlights(
        [
          review("plain", { severity: "alert", start_time: NOW - 10 }),
          review("seen", {
            severity: "alert",
            start_time: NOW - 900,
            data: { detections: ["p1"] },
          }),
          review("threat", {
            severity: "alert",
            start_time: NOW - 1200,
            data: {
              detections: ["p1"],
              metadata: {
                title: "Person at the gate",
                scene: "",
                confidence: 0.9,
                potential_threat_level: 2,
              },
            },
          }),
        ],
        EMPTY_CONTEXT,
      ).items,
    );
    expect(groups.map((group) => group.lead.review.id)).toEqual([
      "threat",
      "plain",
    ]);
    expect(groups.at(0)?.others.map((item) => item.review.id)).toEqual([
      "seen",
    ]);
  });
});

describe("chip counts", () => {
  const { items } = rankSpotlights(
    [
      ...Array.from({ length: 5 }, (_, index) =>
        review(`alice-${index}`, {
          severity: "alert",
          has_been_reviewed: false,
          start_time: NOW - 60 * (index + 1),
          data: { sub_labels: ["Alice"], detections: ["p1"] },
        }),
      ),
      review("glass", {
        severity: "alert",
        has_been_reviewed: false,
        data: { audio: ["glass"], objects: [] },
      }),
      review("car", {
        severity: "alert",
        has_been_reviewed: false,
        data: { objects: ["car"] },
      }),
    ],
    CONTEXT,
  );

  it("counts the cards each chip shows, repeats as one", () => {
    expect(countGroups(items)).toEqual({
      all: 3,
      people: 1,
      vehicles: 1,
      threats: 1,
      unreviewed: 3,
    });
    expect(inCategory(items, "people")).toHaveLength(5);
    expect(inCategory(items, undefined)).toHaveLength(7);
  });

  it("hides the unreviewed chip while it holds every card", () => {
    const counts = countGroups(items);
    expect(shownCategories(counts, undefined)).toEqual([
      "people",
      "vehicles",
      "threats",
    ]);
    // still there while selected, so it can be turned off
    expect(shownCategories(counts, "unreviewed")).toContain("unreviewed");
    expect(shownCategories({ ...counts, unreviewed: 2 }, undefined)).toContain(
      "unreviewed",
    );
  });
});

describe("context builders", () => {
  it("reads known plate names", () => {
    expect([...knownPlateNames({ "Bob's Tesla": ["ABC123"] })]).toEqual([
      "Bob's Tesla",
    ]);
    expect(knownPlateNames(null).size).toBe(0);
  });

  it("finds the zones with a loitering time", () => {
    const zones = loiteringZoneMap({
      front_door: {
        zones: {
          porch: { loitering_time: 10 },
          street: { loitering_time: 0 },
        },
      },
      garage: { zones: { bay: { loitering_time: 0 } } },
      backyard: {},
    });
    expect(Object.keys(zones)).toEqual(["front_door"]);
    expect(zones).toEqual({ front_door: new Set(["porch"]) });
    expect(loiteringZoneMap(undefined)).toEqual({});
  });

  it("maps tracked objects to their recognized plates", () => {
    const plates = platesByEvent([
      { id: "car-1", data: { recognized_license_plate: " ABC123 " } },
      { id: "car-2", data: { recognized_license_plate: null } },
      { id: "car-3", data: {} },
      { id: "car-4", data: null },
    ]);
    expect([...plates]).toEqual([["car-1", "ABC123"]]);
    expect(platesByEvent(undefined).size).toBe(0);
  });

  it("windows by end time like the review API", () => {
    expect(
      inSpotlightWindow(review("a", { end_time: NOW - 10 }), {
        after: NOW - 60,
        cameras: undefined,
      }),
    ).toBe(true);
    expect(
      inSpotlightWindow(review("b", { end_time: NOW - 120 }), {
        after: NOW - 60,
        cameras: undefined,
      }),
    ).toBe(false);
  });
});
