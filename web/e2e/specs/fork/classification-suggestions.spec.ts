/**
 * Fork (I41): suggested classes on the classification train grid.
 *
 * The grid asks /classification/{model}/suggestions for the events on the
 * page and shows a badge with the draft class. Confirm files every image of
 * the event through the fork's confirm endpoint.
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

// Train file names are `{eventId}-{timestamp}-{label}-{score}.webp`, and the
// event id itself holds one dash.
const TRAIN = [
  "1780673409.365581-abc123-1780673410.0-unknown-0.0.webp",
  "1780673409.365581-abc123-1780673412.0-unknown-0.0.webp",
  "1780673500.0-def456-1780673501.0-unknown-0.0.webp",
];
const EVENT_VAN = "1780673409.365581-abc123";
const EVENT_OTHER = "1780673500.0-def456";

function event(id: string, description: string) {
  return {
    id,
    label: "car",
    sub_label: null,
    camera: "backyard",
    start_time: 1780673409,
    end_time: 1780673454,
    false_positive: false,
    zones: [],
    thumbnail: null,
    has_clip: true,
    has_snapshot: true,
    retain_indefinitely: false,
    plus_id: null,
    data: {
      top_score: 0.9,
      score: 0.9,
      region: [0, 0, 1, 1],
      box: [0, 0, 1, 1],
      area: 1,
      ratio: 1,
      type: "object",
      description,
      path_data: [],
    },
  };
}

const SUGGESTIONS = {
  model: MODEL,
  classes: ["none", "suv", "van"],
  jev: {
    enabled: true,
    configured: true,
    used_today: 1,
    daily_request_limit: 200,
  },
  suggestions: {
    [EVENT_VAN]: {
      text: {
        category: "van",
        source: "text",
        score: null,
        evidence: "a white van",
      },
      jev: { category: "van", source: "jev", score: 0.97, evidence: "" },
      jev_status: "answered",
      suggestion: {
        category: "van",
        source: "jev",
        score: 0.97,
        evidence: "a white van is parked",
      },
      conflict: false,
    },
    [EVENT_OTHER]: {
      text: null,
      jev: null,
      jev_status: "unknown",
      suggestion: null,
      conflict: false,
    },
  },
};

test.describe("Classification suggestions @medium", () => {
  test("shows the draft class and confirms every image of the event @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let train = [...TRAIN];
    const confirms: unknown[] = [];

    await frigateApp.installDefaults({
      config: { classification: { custom: CUSTOM_MODELS } },
    });
    await page.route(
      new RegExp(`/api/classification/${MODEL}/dataset`),
      (route) =>
        route.fulfill({ json: { categories: { van: [], suv: [], none: [] } } }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/train$`),
      (route) => route.fulfill({ json: train }),
    );
    await page.route("**/api/event_ids**", (route) =>
      route.fulfill({
        json: [
          event(EVENT_VAN, "A white van is parked."),
          event(EVENT_OTHER, "Something drives by."),
        ],
      }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions\\?`),
      (route) => route.fulfill({ json: SUGGESTIONS }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions/confirm`),
      async (route) => {
        confirms.push(route.request().postDataJSON());
        train = train.filter((name) => !name.startsWith(EVENT_VAN));
        return route.fulfill({
          json: {
            success: true,
            message: "ok",
            moved: ["van-1.png", "van-2.png"],
          },
        });
      },
    );
    await page.route("**/clips/**", (route) =>
      route.fulfill({
        contentType: "image/webp",
        body: Buffer.from(
          "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
          "base64",
        ),
      }),
    );

    await frigateApp.goto("/classification");
    await page.getByText(MODEL).first().click();
    await expect(page.getByRole("button", { name: /back/i })).toBeVisible({
      timeout: 10_000,
    });

    const badge = page.getByTestId("suggestion-badge");
    await expect(badge).toHaveCount(1, { timeout: 10_000 });
    await expect(badge).toContainText("van");
    await expect(badge).toContainText("97%");

    await badge.getByRole("button", { name: /confirm van/i }).click();

    await expect.poll(() => confirms.length).toBe(1);
    expect(confirms[0]).toEqual({
      event_id: EVENT_VAN,
      category: "van",
      training_files: [TRAIN[0], TRAIN[1]],
      source: "jev",
      score: 0.97,
      suggested_category: "van",
    });
    await expect(page.getByText(/filed 2 images as van/i)).toBeVisible();
    await expect(page.getByTestId("suggestion-badge")).toHaveCount(0);
  });

  test("shows nothing when the flag is off", async ({ frigateApp }) => {
    const { page } = frigateApp;
    let asked = 0;

    await frigateApp.installDefaults({
      config: { classification: { custom: CUSTOM_MODELS } },
    });
    await page.route(
      new RegExp(`/api/classification/${MODEL}/dataset`),
      (route) => route.fulfill({ json: { categories: { van: [] } } }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/train$`),
      (route) => route.fulfill({ json: [TRAIN[0]] }),
    );
    await page.route("**/api/event_ids**", (route) =>
      route.fulfill({ json: [event(EVENT_VAN, "A white van is parked.")] }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions`),
      (route) => {
        asked += 1;
        return route.fulfill({ json: SUGGESTIONS });
      },
    );
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "frigateFork",
        JSON.stringify({ classificationSuggestions: false }),
      );
    });

    await frigateApp.goto("/classification");
    await page.getByText(MODEL).first().click();
    await expect(page.getByRole("button", { name: /back/i })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('img[src*="/train/"]')).toHaveCount(1, {
      timeout: 10_000,
    });

    await expect(page.getByTestId("suggestion-badge")).toHaveCount(0);
    expect(asked).toBe(0);
  });
});
