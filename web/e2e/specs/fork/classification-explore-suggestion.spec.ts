/**
 * Fork (I46): the draft class in the Explore detail dialog.
 *
 * The dialog asks /classification/suggestions/event/{id} and shows one line
 * per custom model: the draft, its source, what the trained model said, and
 * a File button that goes through the fork's confirm endpoint.
 */

import { test, expect } from "../../fixtures/frigate-test";

const MODEL = "vehicle_type";
const CUSTOM_MODELS = {
  [MODEL]: {
    name: MODEL,
    threshold: 0.8,
    object_config: { objects: ["car"], classification_type: "attribute" },
  },
};

function eventSuggestions(eventId: string, filed: boolean) {
  return {
    event_id: eventId,
    models: [
      {
        model: MODEL,
        classes: ["none", "sedan", "suv"],
        suggestion: {
          text: null,
          jev: null,
          jev_status: "answered",
          suggestion: {
            category: "suv",
            source: "jev",
            score: 0.97,
            evidence: "A white SUV is parked.",
          },
          conflict: false,
        },
        training_files: filed ? [] : ["evt-1.0-unknown-0.0.webp"],
        model_said: "sedan",
        filed: filed ? { category: "suv", auto: false } : null,
      },
    ],
  };
}

test.describe("Explore suggestion (fork I46)", () => {
  test("shows the draft, the model's answer, and files in one click", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const confirms: unknown[] = [];
    let filed = false;

    await frigateApp.installDefaults({
      config: { classification: { custom: CUSTOM_MODELS } },
    });
    await page.route(
      /\/api\/classification\/suggestions\/event\/([^/?]+)/,
      (route) => {
        const id = decodeURIComponent(
          route.request().url().split("/suggestions/event/")[1].split("?")[0],
        );
        return route.fulfill({ json: eventSuggestions(id, filed) });
      },
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions/confirm`),
      (route) => {
        confirms.push(route.request().postDataJSON());
        filed = true;
        return route.fulfill({
          json: { success: true, message: "ok", moved: ["suv-1.png"] },
        });
      },
    );

    await frigateApp.goto("/explore?labels=car");
    const firstResult = page.locator("[data-start]").first();
    await expect(firstResult).toBeVisible({ timeout: 10_000 });
    await firstResult.click();

    const box = page.getByTestId("explore-suggestion");
    await expect(box).toBeVisible();
    await expect(box).toContainText("vehicle_type: suv");
    await expect(box).toContainText("Jev 97%");
    await expect(page.getByTestId("explore-model-said")).toContainText(
      "model said sedan",
    );

    await box.getByRole("button", { name: "File" }).click();
    await expect.poll(() => confirms.length).toBe(1);
    expect(confirms[0]).toMatchObject({
      category: "suv",
      suggested_category: "suv",
      source: "jev",
      training_files: ["evt-1.0-unknown-0.0.webp"],
    });
    await expect(box).toContainText("filed as suv");
    await expect(box.getByRole("button", { name: "File" })).toHaveCount(0);
  });

  test("stays silent with the flag off", async ({ frigateApp }) => {
    const { page } = frigateApp;
    let asked = 0;
    await frigateApp.installDefaults({
      config: { classification: { custom: CUSTOM_MODELS } },
    });
    await page.route(/\/api\/classification\/suggestions\/event\//, (route) => {
      asked += 1;
      return route.fulfill({ json: eventSuggestions("x", false) });
    });
    await page.addInitScript(() => {
      localStorage.frigateFork = '{"classificationSuggestions":false}';
    });
    await frigateApp.goto("/explore?labels=car");
    const firstResult = page.locator("[data-start]").first();
    await expect(firstResult).toBeVisible({ timeout: 10_000 });
    await firstResult.click();
    // A dialog on desktop, a full page on phones: the title shows in both.
    await expect(
      page.getByText(/tracked object details/i).first(),
    ).toBeVisible();
    await expect(page.getByTestId("explore-suggestion")).toHaveCount(0);
    expect(asked).toBe(0);
  });
});
