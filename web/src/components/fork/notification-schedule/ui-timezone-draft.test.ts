import { describe, expect, it } from "vitest";

import type { FrigateConfig } from "@/types/frigateConfig";

import { uiTimezoneDraft } from "./ui-timezone-draft";

const asConfig = (value: unknown) => value as FrigateConfig;

const config = asConfig({
  ui: { timezone: null, time_format: "browser", unit_system: "metric" },
  cameras: {},
});

describe("uiTimezoneDraft", () => {
  it("sets the timezone on the saved UI section", () => {
    expect(uiTimezoneDraft(config, undefined, "America/Chicago")).toEqual({
      timezone: "America/Chicago",
      time_format: "browser",
      unit_system: "metric",
    });
  });

  it("keeps unsaved UI edits", () => {
    expect(
      uiTimezoneDraft(
        config,
        { time_format: "24hour", unit_system: "imperial" },
        "Europe/Paris",
      ),
    ).toEqual({
      timezone: "Europe/Paris",
      time_format: "24hour",
      unit_system: "imperial",
    });
  });
});
