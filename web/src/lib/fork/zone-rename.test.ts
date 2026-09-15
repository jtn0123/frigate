import { describe, expect, it } from "vitest";
import {
  type ZoneRenameSource,
  queryToConfigData,
  zoneRename,
  zoneRenameConfigData,
} from "./zone-rename";

function camera(extra: Partial<ZoneRenameSource> = {}): ZoneRenameSource {
  return {
    review: {
      alerts: { required_zones: ["driveway"] },
      detections: { required_zones: [] },
    },
    objects: { genai: { required_zones: [] } },
    snapshots: { required_zones: ["driveway", "porch"] },
    mqtt: { required_zones: ["driveway"] },
    onvif: { autotracking: { required_zones: [] } },
    ...extra,
  };
}

describe("zoneRename", () => {
  it("moves the name in every required_zones list that has it", () => {
    expect(zoneRename("front", camera(), "driveway", "front_drive")).toEqual({
      cameras: {
        front: {
          review: { alerts: { required_zones: ["front_drive"] } },
          snapshots: { required_zones: ["front_drive", "porch"] },
          mqtt: { required_zones: ["front_drive"] },
        },
      },
    });
  });

  it("leaves a zone no list names alone", () => {
    expect(zoneRename("front", camera(), "yard", "garden")).toEqual({});
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

    expect(rename).toMatchObject({
      cameras: {
        front: {
          profiles: {
            armed: { zones: { driveway: null, front_drive: override } },
          },
        },
      },
    });
    expect(JSON.stringify(rename)).not.toContain("away");
  });

  it("does nothing without a camera config", () => {
    expect(zoneRename("front", undefined, "driveway", "x")).toEqual({});
  });
});

describe("queryToConfigData", () => {
  it("reads values the way config/set reads its query string", () => {
    const zone = "cameras.front.zones.a";
    expect(
      queryToConfigData(
        `${zone}.coordinates=0.1,0.2,0.3,0.4&${zone}.enabled=True` +
          `&${zone}.inertia=3&${zone}.speed_threshold=2.5` +
          `&${zone}.objects=car&${zone}.objects=person` +
          `&${zone}.friendly_name=Front%20drive&${zone}.distances`,
      ),
    ).toEqual({
      cameras: {
        front: {
          zones: {
            a: {
              coordinates: "0.1,0.2,0.3,0.4",
              enabled: true,
              inertia: 3,
              speed_threshold: 2.5,
              objects: ["car", "person"],
              friendly_name: "Front drive",
              distances: null,
            },
          },
        },
      },
    });
  });
});

describe("zoneRenameConfigData", () => {
  it("deletes the old zone, writes the new one and moves its names in one body", () => {
    const zone = "cameras.front.zones.front_drive";
    const data = zoneRenameConfigData(
      "cameras.front.zones.driveway",
      `${zone}.coordinates=0,0,1,0,1,1&${zone}.enabled=True`,
      zoneRename("front", camera(), "driveway", "front_drive"),
    );

    expect(data).toEqual({
      cameras: {
        front: {
          zones: {
            driveway: null,
            front_drive: { coordinates: "0,0,1,0,1,1", enabled: true },
          },
          review: { alerts: { required_zones: ["front_drive"] } },
          snapshots: { required_zones: ["front_drive", "porch"] },
          mqtt: { required_zones: ["front_drive"] },
        },
      },
    });
    // the backend applies keys in order, so the delete comes first
    const body = JSON.stringify(data);
    expect(body.indexOf('"driveway":null')).toBeLessThan(
      body.indexOf('"front_drive":{'),
    );
  });

  it("renames a profile's own zone without touching the base config", () => {
    expect(
      zoneRenameConfigData(
        "cameras.front.profiles.armed.zones.a",
        "cameras.front.profiles.armed.zones.b.coordinates=0,0,1,1",
      ),
    ).toEqual({
      cameras: {
        front: {
          profiles: {
            armed: { zones: { a: null, b: { coordinates: "0,0,1,1" } } },
          },
        },
      },
    });
  });
});
