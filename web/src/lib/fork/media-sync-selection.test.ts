import { describe, expect, it } from "vitest";
import {
  ALL_MEDIA,
  MEDIA_SYNC_TYPES,
  isMediaTypeSelected,
  toggleMediaType,
} from "./media-sync-selection";

describe("toggleMediaType", () => {
  it("turns All media on and off", () => {
    expect(toggleMediaType([], ALL_MEDIA, true)).toEqual([ALL_MEDIA]);
    expect(toggleMediaType([ALL_MEDIA], ALL_MEDIA, false)).toEqual([]);
  });

  it("keeps the other types when one is turned off under All media", () => {
    expect(toggleMediaType([ALL_MEDIA], "exports", false)).toEqual(
      MEDIA_SYNC_TYPES.filter((type) => type !== "exports"),
    );
  });

  it("collapses back to All media once every type is on", () => {
    const allButExports = MEDIA_SYNC_TYPES.filter((type) => type !== "exports");
    expect(toggleMediaType(allButExports, "exports", true)).toEqual([
      ALL_MEDIA,
    ]);
  });

  it("adds and removes single types in list order", () => {
    expect(toggleMediaType(["recordings"], "previews", true)).toEqual([
      "previews",
      "recordings",
    ]);
    expect(toggleMediaType(["previews"], "previews", false)).toEqual([]);
  });
});

describe("isMediaTypeSelected", () => {
  it("counts All media as every type", () => {
    expect(isMediaTypeSelected([ALL_MEDIA], "exports")).toBe(true);
    expect(isMediaTypeSelected(["previews"], "exports")).toBe(false);
  });
});
