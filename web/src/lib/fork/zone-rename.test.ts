import { describe, expect, it } from "vitest";
import { type ZoneRenameSource, zoneRename } from "./zone-rename";

function camera(extra: Partial<ZoneRenameSource> = {}): ZoneRenameSource {
  return {
    objects: { genai: { required_zones: [] } },
    snapshots: { required_zones: ["driveway", "porch"] },
    mqtt: { required_zones: ["driveway"] },
    onvif: { autotracking: { required_zones: [] } },
    ...extra,
  };
}

describe("zoneRename", () => {
  it("moves the name in every required_zones list that has it", () => {
    const rename = zoneRename("front", camera(), "driveway", "front_drive");

    // an emptied list is deleted first, then written back with the new name
    expect(rename.removals).toBe(
      "&cameras.front.snapshots.required_zones=porch" +
        "&cameras.front.mqtt.required_zones",
    );
    expect(rename.additions).toBe(
      "&cameras.front.snapshots.required_zones=front_drive" +
        "&cameras.front.snapshots.required_zones=porch" +
        "&cameras.front.mqtt.required_zones=front_drive",
    );
    expect(rename.profileData).toBeUndefined();
  });

  it("leaves a zone no list names alone", () => {
    expect(zoneRename("front", camera(), "yard", "garden")).toEqual({
      removals: "",
      additions: "",
      profileData: undefined,
    });
  });

  it("moves profile overrides under the new name", () => {
    const override = { coordinates: "0,0,1,0,1,1", objects: ["car"] };
    const rename = zoneRename(
      "front",
      camera({
        profiles: {
          armed: { zones: { driveway: override } },
          away: { zones: { porch: { objects: ["person"] } } },
        },
      }),
      "driveway",
      "front_drive",
    );

    expect(rename.removals).toContain(
      "&cameras.front.profiles.armed.zones.driveway",
    );
    expect(rename.removals).not.toContain("profiles.away");
    expect(rename.profileData).toEqual({
      cameras: {
        front: { profiles: { armed: { zones: { front_drive: override } } } },
      },
    });
  });

  it("does nothing without a camera config", () => {
    expect(zoneRename("front", undefined, "driveway", "x")).toEqual({
      removals: "",
      additions: "",
    });
  });
});
