import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  VIEWER_SETTINGS_SECTIONS,
  visibleCameraGroups,
} from "./command-items";
import { allSettingsViews, settingsViewGroups } from "@/types/settings";

describe("SETTINGS_SECTIONS", () => {
  it("lists every menu section once, in menu order, with its group", () => {
    const expected = settingsViewGroups.flatMap((group) =>
      group.views.map((key) => `${group.label}/${key}`),
    );
    expect(
      SETTINGS_SECTIONS.map((section) => `${section.group}/${section.key}`),
    ).toEqual(expected);
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.key)).size).toBe(
      SETTINGS_SECTIONS.length,
    );
  });

  it("leaves out the sections without a menu entry", () => {
    const keys = SETTINGS_SECTIONS.map((section) => section.key);
    expect(keys).not.toContain("debug");
    expect(keys).not.toContain("enrichments");
    expect(allSettingsViews).toEqual([...keys, "enrichments", "debug"]);
  });

  it("gives viewers only the UI settings and notifications", () => {
    expect([...VIEWER_SETTINGS_SECTIONS]).toEqual([
      "uiSettings",
      "notifications",
    ]);
  });
});

describe("visibleCameraGroups", () => {
  const groups = {
    default: { cameras: ["front_door", "garage"] },
    outdoor: { cameras: ["backyard"] },
    empty: { cameras: [] },
  };

  it("keeps every group with cameras for full access", () => {
    expect(
      visibleCameraGroups(groups, ["front_door", "garage", "backyard"], true),
    ).toEqual([
      { name: "default", cameras: ["front_door", "garage"] },
      { name: "outdoor", cameras: ["backyard"] },
    ]);
  });

  it("drops groups and search terms a restricted role cannot see", () => {
    expect(visibleCameraGroups(groups, ["garage"], false)).toEqual([
      { name: "default", cameras: ["garage"] },
    ]);
  });

  it("handles a config without camera groups", () => {
    expect(visibleCameraGroups(undefined, ["garage"], false)).toEqual([]);
  });
});
