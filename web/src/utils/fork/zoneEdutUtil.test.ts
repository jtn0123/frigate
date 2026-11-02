import { afterEach, describe, expect, it } from "vitest";
import { zoneReferenceUpdates } from "@/utils/zoneEdutUtil";
import type { CameraConfig } from "@/types/frigateConfig";

// Only the sections zoneReferenceUpdates reads; the rest of a camera's
// config does not matter to it.
const asCamera = (value: unknown) => value as CameraConfig;

function camera(extra: Record<string, unknown> = {}): CameraConfig {
  return asCamera({
    review: {
      alerts: { required_zones: ["driveway"] },
      detections: { required_zones: [] },
    },
    objects: { genai: { required_zones: [] } },
    snapshots: { required_zones: ["driveway", "porch"] },
    mqtt: { required_zones: ["driveway"] },
    onvif: { autotracking: { required_zones: [] } },
    ...extra,
  });
}

describe("zoneReferenceUpdates", () => {
  it("moves the name in every required_zones list that has it", () => {
    expect(zoneReferenceUpdates(camera(), "driveway", "front_drive")).toEqual({
      review: { alerts: { required_zones: ["front_drive"] } },
      snapshots: { required_zones: ["front_drive", "porch"] },
      mqtt: { required_zones: ["front_drive"] },
    });
  });

  it("drops the name when there is no new one, keeping emptied lists", () => {
    expect(zoneReferenceUpdates(camera(), "driveway")).toEqual({
      review: { alerts: { required_zones: [] } },
      snapshots: { required_zones: ["porch"] },
      mqtt: { required_zones: [] },
    });
  });

  it("leaves a zone no list names alone", () => {
    expect(zoneReferenceUpdates(camera(), "yard", "garden")).toEqual({});
  });

  it("does not list a zone twice when the new name is already there", () => {
    expect(
      zoneReferenceUpdates(
        camera({ mqtt: { required_zones: ["driveway", "porch"] } }),
        "driveway",
        "porch",
      ),
    ).toMatchObject({ mqtt: { required_zones: ["porch"] } });
  });

  it("reads the base config while a profile is active", () => {
    // the active profile's lists are merged into the top level sections
    const updates = zoneReferenceUpdates(
      camera({
        snapshots: { required_zones: ["porch"] },
        base_config: { snapshots: { required_zones: ["driveway"] } },
      }),
      "driveway",
      "front_drive",
    );
    expect(updates).toMatchObject({
      snapshots: { required_zones: ["front_drive"] },
    });
  });

  it("moves profile zone overrides and the lists a profile overrides", () => {
    const override = { coordinates: "0,0,1,0,1,1", objects: ["car"] };
    const updates = zoneReferenceUpdates(
      camera({
        profiles: {
          armed: {
            zones: { driveway: override },
            review: { alerts: { required_zones: ["driveway", "porch"] } },
          },
          away: { zones: { porch: { objects: ["person"] } } },
        },
      }),
      "driveway",
      "front_drive",
    );

    expect(updates).toMatchObject({
      profiles: {
        armed: {
          zones: { driveway: null, front_drive: override },
          review: { alerts: { required_zones: ["front_drive", "porch"] } },
        },
      },
    });
    expect(JSON.stringify(updates)).not.toContain("away");
  });

  it("keeps a numeric profile name an object key", () => {
    const updates = zoneReferenceUpdates(
      camera({ profiles: { "2": { zones: { driveway: { inertia: 3 } } } } }),
      "driveway",
    );
    const profiles = updates["profiles"] as Record<string, unknown>;
    expect(Array.isArray(profiles)).toBe(false);
    expect(profiles["2"]).toEqual({ zones: { driveway: null } });
  });

  describe("prototype pollution guard (E17)", () => {
    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>)["inertia"];
    });

    it("does not move a zone to an unsafe name", () => {
      const updates = zoneReferenceUpdates(
        camera({
          profiles: { night: { zones: { driveway: { inertia: 5 } } } },
        }),
        "driveway",
        "__proto__",
      );
      expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain(
        "inertia",
      );
      expect(({} as Record<string, unknown>)["inertia"]).toBeUndefined();
      expect(updates).toMatchObject({
        profiles: { night: { zones: { driveway: null } } },
      });
    });
  });
});
