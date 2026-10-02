import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FrigateConfig } from "@/types/frigateConfig";
import {
  getAttributeLabels,
  getIconForLabel,
  isValidIconName,
} from "@/utils/iconUtil";

const cfg = (value: unknown) => value as FrigateConfig;

function markup(label: string, type: "object" | "audio" = "object") {
  return render(<>{getIconForLabel(label, type, "size-4")}</>).container
    .innerHTML;
}

const OBJECT_LABELS = [
  "baby",
  "baby_stroller",
  "bbq_grill",
  "bear",
  "bicycle",
  "bird",
  "boat",
  "bus",
  "car",
  "cat",
  "cow",
  "deer",
  "dog",
  "fox",
  "garbage_truck",
  "goat",
  "horse",
  "kangaroo",
  "license_plate",
  "motorcycle",
  "mouse",
  "package",
  "person",
  "possum",
  "rabbit",
  "raccoon",
  "robot_lawnmower",
  "rodent",
  "sports_ball",
  "skunk",
  "squirrel",
  "umbrella",
  "waste_bin",
  "speech",
  "fire_alarm",
  "amazon",
  "royal_mail",
  "dhl",
  "fedex",
  "ups",
  "usps",
];

describe("getIconForLabel", () => {
  it("gives every known label a dedicated icon", () => {
    const fallback = markup("not_a_label");
    const icons = new Set<string>();
    for (const label of OBJECT_LABELS) {
      const html = markup(label);
      expect(html, label).toContain("<svg");
      expect(html, label).toContain('class="size-4"');
      expect(html, label).not.toBe(fallback);
      icons.add(html);
    }
    // each label in the list maps to a distinct icon
    expect(icons.size).toBe(OBJECT_LABELS.length);
  });

  it.each([
    ["school_bus", "bus"],
    ["vehicle", "car"],
    ["animal", "dog"],
    ["bark", "dog"],
    ["crying", "speech"],
    ["laughter", "speech"],
    ["scream", "speech"],
    ["yell", "speech"],
    ["an_post", "royal_mail"],
    ["canada_post", "royal_mail"],
    ["dpd", "royal_mail"],
    ["gls", "royal_mail"],
    ["nzpost", "royal_mail"],
    ["postnl", "royal_mail"],
    ["postnord", "royal_mail"],
    ["purolator", "royal_mail"],
  ])("shares the %s icon with %s", (alias, label) => {
    expect(markup(alias)).toBe(markup(label));
  });

  it("uses a sound wave for unknown audio labels", () => {
    expect(markup("glass_break", "audio")).not.toBe(markup("glass_break"));
    expect(markup("speech", "audio")).toBe(markup("speech"));
  });

  it("badges verified and recognized-plate labels", () => {
    const verified = render(
      <>{getIconForLabel("person-verified")}</>,
    ).container;
    expect(verified.firstElementChild?.className).toBe(
      "relative flex items-center",
    );
    expect(verified.querySelectorAll("svg")).toHaveLength(2);
    expect(verified.firstElementChild?.firstElementChild?.outerHTML).toBe(
      render(<>{getIconForLabel("person")}</>).container.innerHTML,
    );

    const plate = render(<>{getIconForLabel("car-plate")}</>).container;
    expect(plate.firstElementChild?.className).toBe(
      "relative inline-flex items-center",
    );
    expect(plate.querySelectorAll("svg")).toHaveLength(2);
  });
});

describe("getAttributeLabels", () => {
  it("returns nothing without a config", () => {
    expect(getAttributeLabels()).toEqual([]);
  });

  it("collects unique attribute labels across models", () => {
    const config = cfg({
      models: [
        {
          attributes_map: {
            person: ["face", "amazon"],
            car: ["license_plate"],
          },
        },
        { attributes_map: { person: ["face"] } },
        {},
      ],
    });
    expect(getAttributeLabels(config)).toEqual([
      "face",
      "amazon",
      "license_plate",
    ]);
  });

  it("tolerates a config without models", () => {
    expect(getAttributeLabels({} as FrigateConfig)).toEqual([]);
  });
});

describe("isValidIconName", () => {
  it("accepts lucide names only", () => {
    expect(isValidIconName("LuCamera")).toBe(true);
    expect(isValidIconName("FaCamera")).toBe(false);
    expect(isValidIconName("Lucamera")).toBe(false);
  });
});
