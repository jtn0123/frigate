import { describe, expect, it } from "vitest";
import { removeRequiredZoneQuery, reviewQueries } from "@/utils/zoneEdutUtil";

// callers can pass a missing list from an unset config
const asZones = (value: unknown) => value as string[];
const noZones = asZones(undefined);

describe("removeRequiredZoneQuery", () => {
  it("leaves sections without the zone untouched", () => {
    expect(
      removeRequiredZoneQuery("yard", "front", "snapshots", ["porch"]),
    ).toBe("");
    expect(removeRequiredZoneQuery("yard", "front", "snapshots", noZones)).toBe(
      "",
    );
  });

  it("rebuilds the remaining zones", () => {
    expect(
      removeRequiredZoneQuery("yard", "front", "objects.genai", [
        "porch",
        "yard",
        "drive",
      ]),
    ).toBe(
      "&cameras.front.objects.genai.required_zones=porch" +
        "&cameras.front.objects.genai.required_zones=drive",
    );
  });

  it("deletes the key when the last zone is removed", () => {
    expect(removeRequiredZoneQuery("yard", "front", "mqtt", ["yard"])).toBe(
      "&cameras.front.mqtt.required_zones",
    );
  });
});

describe("reviewQueries", () => {
  it("adds the zone to both alerts and detections", () => {
    expect(reviewQueries("yard", true, true, "front", ["porch"], [])).toEqual({
      alertQueries:
        "&cameras.front.review.alerts.required_zones=porch" +
        "&cameras.front.review.alerts.required_zones=yard",
      detectionQueries: "&cameras.front.review.detections.required_zones=yard",
    });
  });

  it("removes the zone and keeps the other required zones", () => {
    expect(
      reviewQueries(
        "yard",
        false,
        false,
        "front",
        ["yard", "porch"],
        ["porch", "yard"],
      ),
    ).toEqual({
      alertQueries: "&cameras.front.review.alerts.required_zones=porch",
      detectionQueries: "&cameras.front.review.detections.required_zones=porch",
    });
  });

  it("resets a list that only held the removed zone", () => {
    expect(
      reviewQueries("yard", false, false, "front", ["yard"], ["yard"]),
    ).toEqual({
      alertQueries: "&cameras.front.review.alerts",
      detectionQueries: "&cameras.front.review.detections",
    });
  });

  it("emits nothing for lists that never had the zone", () => {
    expect(reviewQueries("yard", false, false, "front", noZones, [])).toEqual({
      alertQueries: "",
      detectionQueries: "",
    });
  });
});
