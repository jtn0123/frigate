/**
 * Fork (I46): the draft class in the Explore detail dialog.
 *
 * The dialog asks /classification/suggestions/event/{id} and shows one line
 * per custom model: the guess, how sure it is, what the trained model
 * thinks, and an Add button that goes through the fork's confirm endpoint.
 * A group someone already moved reads as sorted, and a failed add shows the
 * server's reason; both refresh the line.
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

const ADD_BUTTON = "Add as suv for Vehicle type";

function eventSuggestions(
  eventId: string,
  filed: boolean,
  waiting: boolean = !filed,
) {
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
        training_files: waiting ? ["evt-1.0-unknown-0.0.webp"] : [],
        model_said: "sedan",
        filed: filed ? { category: "suv", auto: false } : null,
      },
    ],
  };
}

test.describe("Explore suggestion (fork I46)", () => {
  test("shows the guess, the model's answer, and adds in one click @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const confirms: unknown[] = [];
    let filed = false;

    await frigateApp.installDefaults({
      config: { classification: { custom: CUSTOM_MODELS } },
    });
    const eventRoute = /\/api\/classification\/suggestions\/event\/([^/?]+)/;
    await page.route(eventRoute, (route) => {
      const id = decodeURIComponent(
        eventRoute.exec(route.request().url())?.[1] ?? "",
      );
      return route.fulfill({ json: eventSuggestions(id, filed) });
    });
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
    await expect(box).toContainText("Vehicle type");
    await expect(box).not.toContainText("vehicle_type");
    await expect(box).toContainText("Guess: suv");
    await expect(box).toContainText("97% sure");
    await expect(box).not.toContainText("Jev");
    await expect(page.getByTestId("explore-model-said")).toContainText(
      "Your model thinks: sedan",
    );

    const add = box.getByRole("button", { name: ADD_BUTTON });
    await expect(add).toHaveText("Add as suv");
    await add.click();
    await expect.poll(() => confirms.length).toBe(1);
    expect(confirms[0]).toMatchObject({
      category: "suv",
      suggested_category: "suv",
      source: "jev",
      training_files: ["evt-1.0-unknown-0.0.webp"],
    });
    await expect(box).toContainText("In training as suv");
    await expect(box.getByRole("button", { name: ADD_BUTTON })).toHaveCount(0);
  });

  test("reads an already accepted group as sorted and refreshes", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let moved = false;
    let fetches = 0;

    await frigateApp.installDefaults({
      config: { classification: { custom: CUSTOM_MODELS } },
    });
    await page.route(/\/api\/classification\/suggestions\/event\//, (route) => {
      fetches += 1;
      // Someone else moved the images: nothing waits and nothing is filed
      // under this model's record yet.
      return route.fulfill({
        json: eventSuggestions("evt", false, !moved),
      });
    });
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions/confirm`),
      (route) => {
        moved = true;
        return route.fulfill({
          status: 404,
          json: { success: false, message: "already accepted" },
        });
      },
    );

    await frigateApp.goto("/explore?labels=car");
    const firstResult = page.locator("[data-start]").first();
    await expect(firstResult).toBeVisible({ timeout: 10_000 });
    await firstResult.click();

    const box = page.getByTestId("explore-suggestion");
    await expect(box).toBeVisible();
    const before = fetches;
    await box.getByRole("button", { name: ADD_BUTTON }).click();
    await expect(page.getByTestId("explore-already-sorted")).toHaveText(
      "Already sorted",
    );
    await expect(box.getByRole("button", { name: ADD_BUTTON })).toHaveCount(0);
    await expect.poll(() => fetches).toBeGreaterThan(before);
    await expect(page.getByText("Could not add it to training")).toHaveCount(0);
  });

  test("shows the server's reason when adding fails and refreshes", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let fetches = 0;

    await frigateApp.installDefaults({
      config: { classification: { custom: CUSTOM_MODELS } },
    });
    await page.route(/\/api\/classification\/suggestions\/event\//, (route) => {
      fetches += 1;
      return route.fulfill({ json: eventSuggestions("evt", false) });
    });
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions/confirm`),
      (route) =>
        route.fulfill({
          status: 400,
          json: { success: false, message: "suv is not a class of this model" },
        }),
    );

    await frigateApp.goto("/explore?labels=car");
    const firstResult = page.locator("[data-start]").first();
    await expect(firstResult).toBeVisible({ timeout: 10_000 });
    await firstResult.click();

    const box = page.getByTestId("explore-suggestion");
    await expect(box).toBeVisible();
    const before = fetches;
    await box.getByRole("button", { name: ADD_BUTTON }).click();
    await expect(
      page.getByText("Could not add it to training. Try again."),
    ).toBeVisible();
    await expect(
      page.getByText("suv is not a class of this model"),
    ).toBeVisible();
    await expect.poll(() => fetches).toBeGreaterThan(before);
    // Still waiting, so the button comes back for another try.
    await expect(box.getByRole("button", { name: ADD_BUTTON })).toBeEnabled();
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
      window.localStorage.setItem(
        "frigateFork",
        JSON.stringify({ classificationSuggestions: false }),
      );
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
