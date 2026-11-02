/**
 * Fork (B38): the classification model card's cover image (upstream #24768).
 *
 * The card used only the first dataset category after none and unknown, so a
 * model whose first listed category was still empty showed the skeleton even
 * when a later category had images.
 */

import { test, expect } from "../../fixtures/frigate-test";

const MODEL = "object_classifier";
const CUSTOM_MODELS = {
  [MODEL]: {
    name: MODEL,
    object_config: { objects: ["person"], classification_type: "sub_label" },
  },
};

test.describe("Classification cover image @medium @mobile", () => {
  test("uses the first category that has images", async ({ frigateApp }) => {
    await frigateApp.installDefaults({
      config: { classification: { custom: CUSTOM_MODELS } },
    });
    await frigateApp.page.route(
      new RegExp(`/api/classification/${MODEL}/dataset`),
      (route) =>
        route.fulfill({
          json: {
            categories: {
              none: ["none-1.webp"],
              alice: [],
              bob: ["bob-1.webp", "bob-2.webp"],
            },
          },
        }),
    );
    await frigateApp.goto("/classification");

    const cover = frigateApp.page.getByRole("img", {
      name: `Cover image for ${MODEL}`,
    });
    await expect(cover).toBeVisible({ timeout: 10_000 });
    await expect(cover).toHaveAttribute(
      "src",
      new RegExp(`clips/${MODEL}/dataset/bob/bob-1\\.webp$`),
    );
  });
});
