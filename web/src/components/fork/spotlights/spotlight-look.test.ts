import { describe, expect, it, vi } from "vitest";
import type { ReviewSegment } from "@/types/review";
import {
  audioName,
  findSimilarPath,
  itemTitle,
  reasonLook,
  type Translate,
} from "./spotlight-look";

// The real module boots i18next with an HTTP backend; labels read as their
// capitalized key here.
vi.mock("@/utils/i18n", () => ({
  getTranslatedLabel: (label: string, type = "object") =>
    `${type}:${label.charAt(0).toUpperCase()}${label.slice(1)}`,
}));

vi.mock("@/utils/stringUtil", () => ({
  formatList: (items: string[]) => items.join(" and "),
}));

const STRINGS: Record<string, string> = {
  "spotlights.audio.glass": "Glass break",
  "spotlights.audio.smoke_detector": "Smoke alarm",
  "spotlights.reasons.threat": "Threat level {{level}}",
  "spotlights.reasons.face": "Known face: {{name}}",
  "spotlights.reasons.knownPlate": "Known vehicle: {{name}}",
  "spotlights.reasons.plate": "Plate {{plate}}",
  "spotlights.reasons.identified": "Identified: {{name}}",
  "spotlights.reasons.loitering": "Loitering: {{zone}}",
  "spotlights.reasons.alert": "Alert",
  "spotlights.reasons.unreviewed": "Unreviewed",
  securityConcern: "Security concern",
  needsReview: "Needs review",
};

const t: Translate = (key, options) =>
  (STRINGS[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(options?.[name]),
  );

const zoneName = (zone: string) => (zone === "porch" ? "Front porch" : zone);

function review(data: Partial<ReviewSegment["data"]> = {}): ReviewSegment {
  return {
    id: "r1",
    camera: "front_door",
    severity: "alert",
    start_time: 100,
    end_time: 130,
    thumb_path: "/media/frigate/clips/review/thumb-r1.webp",
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: ["event-1"],
      objects: ["person"],
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
      ...data,
    },
  };
}

describe("reasonLook", () => {
  it("writes each reason as a chip", () => {
    const text = (reason: Parameters<typeof reasonLook>[1]) =>
      reasonLook(t, reason, zoneName).text;
    expect(text({ kind: "threat", level: 2 })).toBe("Threat level 2");
    expect(text({ kind: "face", name: "Alice" })).toBe("Known face: Alice");
    expect(text({ kind: "knownPlate", name: "Bob's Tesla" })).toBe(
      "Known vehicle: Bob's Tesla",
    );
    expect(text({ kind: "plate", plate: "ABC123" })).toBe("Plate ABC123");
    expect(text({ kind: "identified", name: "Blue Jay" })).toBe(
      "Identified: Blue Jay",
    );
    expect(text({ kind: "loitering", zone: "porch" })).toBe(
      "Loitering: Front porch",
    );
    expect(text({ kind: "alert" })).toBe("Alert");
    expect(text({ kind: "unreviewed" })).toBe("Unreviewed");
    expect(text({ kind: "audio", label: "glass", critical: true })).toBe(
      "Glass break",
    );
  });

  it("colors by how serious the reason is", () => {
    const tone = (reason: Parameters<typeof reasonLook>[1]) =>
      reasonLook(t, reason, zoneName).tone;
    expect(tone({ kind: "threat", level: 2 })).toContain("red");
    expect(tone({ kind: "threat", level: 1 })).toContain("amber");
    expect(tone({ kind: "audio", label: "glass", critical: true })).toContain(
      "red",
    );
    expect(tone({ kind: "audio", label: "siren", critical: false })).toContain(
      "amber",
    );
    expect(tone({ kind: "unreviewed" })).toContain("border-dashed");
  });

  it("explains the threat level in the tooltip", () => {
    expect(reasonLook(t, { kind: "threat", level: 2 }, zoneName).title).toBe(
      "Security concern",
    );
    expect(reasonLook(t, { kind: "threat", level: 1 }, zoneName).title).toBe(
      "Needs review",
    );
  });
});

describe("audioName", () => {
  it("uses the friendlier name, then the audio label", () => {
    expect(audioName(t, "smoke_detector")).toBe("Smoke alarm");
    expect(audioName(t, "doorbell")).toBe("audio:Doorbell");
  });

  it("has a friendly name for every listed sound", () => {
    for (const label of [
      "glass",
      "shatter",
      "breaking",
      "gunshot",
      "explosion",
      "scream",
      "smoke_detector",
      "fire_alarm",
      "siren",
      "civil_defense_siren",
      "car_alarm",
      "alarm",
      "yell",
    ]) {
      expect(audioName(t, label)).toBe(
        STRINGS[`spotlights.audio.${label}`] ?? `spotlights.audio.${label}`,
      );
    }
  });
});

describe("itemTitle", () => {
  it("prefers the GenAI title", () => {
    expect(
      itemTitle(
        review({
          metadata: {
            title: "Person tries the side door",
            scene: "",
            confidence: 0.9,
          },
        }),
      ),
    ).toBe("Person tries the side door");
  });

  it("lists objects, then sounds, once each", () => {
    expect(
      itemTitle(
        review({
          objects: ["person-verified", "car", "person"],
          audio: ["glass"],
        }),
      ),
    ).toBe("object:Car and object:Person and audio:Glass");
  });
});

describe("findSimilarPath", () => {
  it("links Explore's similarity search for the first object", () => {
    expect(findSimilarPath(review(), true)).toBe(
      "/explore?search_type=similarity&event_id=event-1",
    );
  });

  it("needs semantic search, an object and an id", () => {
    expect(findSimilarPath(review(), false)).toBeUndefined();
    expect(
      findSimilarPath(review({ objects: [], audio: ["glass"] }), true),
    ).toBeUndefined();
    expect(findSimilarPath(review({ detections: [] }), true)).toBeUndefined();
  });
});
