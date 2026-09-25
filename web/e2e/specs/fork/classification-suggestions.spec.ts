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
      new RegExp(`/api/classification/${MODEL}/suggestions/report`),
      (route) =>
        route.fulfill({
          json: {
            model: MODEL,
            total: 20,
            accepted: 17,
            rate: 0.85,
            sources: {},
            classes: {},
            cameras: {},
            first_time: 1,
            last_time: 2,
          },
        }),
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
    const status = page.getByTestId("suggestion-status");
    await expect(status).toContainText("1 draft on this page");
    await expect(status).toContainText("Jev: 1 of 200 requests today");
    await expect(status).toContainText("Kept 85% of 20 drafts");

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

  test("records a hand-picked class on a card with a draft", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const confirms: unknown[] = [];
    let categorized = 0;

    await frigateApp.installDefaults({
      config: { classification: { custom: CUSTOM_MODELS } },
    });
    await page.route(
      new RegExp(`/api/classification/${MODEL}/dataset/categorize`),
      (route) => {
        categorized += 1;
        return route.fulfill({ json: { success: true } });
      },
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/dataset$`),
      (route) =>
        route.fulfill({ json: { categories: { van: [], suv: [], none: [] } } }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/train$`),
      (route) => route.fulfill({ json: [TRAIN[0]] }),
    );
    await page.route("**/api/event_ids**", (route) =>
      route.fulfill({ json: [event(EVENT_VAN, "A white van is parked.")] }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions\\?`),
      (route) => route.fulfill({ json: SUGGESTIONS }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions/confirm`),
      (route) => {
        confirms.push(route.request().postDataJSON());
        return route.fulfill({
          json: { success: true, message: "ok", moved: ["suv-1.png"] },
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
    await expect(page.getByTestId("suggestion-badge")).toHaveCount(1, {
      timeout: 10_000,
    });

    // Open the event's images (a dialog on desktop, a page on phones), then
    // the per-image class picker: a dropdown on desktop, a drawer on phones.
    await page.locator('img[src*="/train/"]').first().click();
    const card = page
      .locator('img[src*="/train/"]')
      .last()
      .locator("xpath=ancestor::div[contains(@class, 'aspect-square')][1]");
    const trigger = card.locator("[aria-haspopup]").first();
    await expect(trigger).toBeVisible({ timeout: 5_000 });
    await trigger.click();
    await page
      .locator('[role="menu"], [role="dialog"]')
      .getByText(/^suv$/i)
      .first()
      .click();

    await expect.poll(() => confirms.length).toBe(1);
    expect(confirms[0]).toEqual({
      event_id: EVENT_VAN,
      category: "suv",
      training_files: [TRAIN[0]],
      source: "jev",
      score: 0.97,
      suggested_category: "van",
    });
    expect(categorized).toBe(0);
    await expect(page.getByText(/filed 1 image as suv/i)).toBeVisible();
  });

  test("files every draft on the page after one confirmation", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const confirms: unknown[] = [];

    await frigateApp.installDefaults({
      config: { classification: { custom: CUSTOM_MODELS } },
    });
    await page.route(
      new RegExp(`/api/classification/${MODEL}/dataset$`),
      (route) =>
        route.fulfill({ json: { categories: { van: [], suv: [], none: [] } } }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/train$`),
      (route) => route.fulfill({ json: TRAIN }),
    );
    await page.route("**/api/event_ids**", (route) =>
      route.fulfill({
        json: [
          event(EVENT_VAN, "A white van is parked."),
          event(EVENT_OTHER, "A gray SUV drives by."),
        ],
      }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions/report`),
      (route) =>
        route.fulfill({
          json: {
            model: MODEL,
            total: 0,
            accepted: 0,
            rate: null,
            sources: {},
            classes: {},
            cameras: {},
            first_time: null,
            last_time: null,
          },
        }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions\\?`),
      (route) =>
        route.fulfill({
          json: {
            ...SUGGESTIONS,
            suggestions: {
              ...SUGGESTIONS.suggestions,
              [EVENT_OTHER]: {
                text: null,
                jev: {
                  category: "suv",
                  source: "jev",
                  score: 0.93,
                  evidence: "",
                },
                jev_status: "answered",
                suggestion: {
                  category: "suv",
                  source: "jev",
                  score: 0.93,
                  evidence: "a gray suv drives by",
                },
                conflict: false,
              },
            },
          },
        }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions/confirm`),
      (route) => {
        confirms.push(route.request().postDataJSON());
        return route.fulfill({
          json: { success: true, message: "ok", moved: ["x.png"] },
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
    const status = page.getByTestId("suggestion-status");
    await expect(status).toContainText("2 drafts on this page", {
      timeout: 10_000,
    });

    await status.getByRole("button", { name: /file all 2 drafts/i }).click();
    const dialog = page.getByTestId("file-all-dialog");
    await expect(dialog).toContainText("File 2 drafts as suggested?");
    await dialog.getByRole("button", { name: /file all 2 drafts/i }).click();

    await expect.poll(() => confirms.length).toBe(2);
    // The grid orders groups differently on phones; only the set matters.
    expect(confirms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: EVENT_VAN,
          category: "van",
          training_files: [TRAIN[0], TRAIN[1]],
        }),
        expect.objectContaining({
          event_id: EVENT_OTHER,
          category: "suv",
          training_files: [TRAIN[2]],
        }),
      ]),
    );
    await expect(page.getByText(/filed 2 of 2 drafts/i)).toBeVisible();
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

  test("lists unsure events first on request and marks crops too small to train on", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    // The newest event the model already scored 95%; the older one 40%.
    const sureEvent = "1780673600.0-sure01";
    const unsureEvent = "1780673500.0-unsure1";
    const tinyEvent = "1780673400.0-tiny01";
    const train = [
      `${sureEvent}-1780673601.0-van-0.95.webp`,
      `${unsureEvent}-1780673501.0-van-0.4.webp`,
      `${tinyEvent}-1780673401.0-suv-0.5.webp`,
    ];
    const draft = (category: string) => ({
      text: { category, source: "text", score: null, evidence: "" },
      jev: null,
      jev_status: "unknown",
      suggestion: { category, source: "text", score: null, evidence: "" },
      conflict: false,
    });

    await frigateApp.installDefaults({
      config: { classification: { custom: CUSTOM_MODELS } },
    });
    await page.route(
      new RegExp(`/api/classification/${MODEL}/dataset$`),
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
          event(sureEvent, "A white van."),
          event(unsureEvent, "A white van."),
          event(tinyEvent, "A gray SUV."),
        ],
      }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions\\?`),
      (route) =>
        route.fulfill({
          json: {
            ...SUGGESTIONS,
            suggestions: {
              [sureEvent]: draft("van"),
              [unsureEvent]: draft("van"),
              [tinyEvent]: draft("suv"),
            },
            too_small: { [tinyEvent]: [train[2]] },
          },
        }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions/report`),
      (route) =>
        route.fulfill({
          json: {
            model: MODEL,
            total: 0,
            accepted: 0,
            rate: null,
            sources: {},
            classes: {},
            cameras: {},
            first_time: null,
            last_time: null,
            dataset: {
              classes: { van: 40, suv: 10, none: 5 },
              empty: [],
              largest: "van",
              smallest: "none",
              ratio: 8,
              lopsided: true,
            },
          },
        }),
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
    const images = page.locator('img[src*="/train/"]');
    await expect(images).toHaveCount(3, { timeout: 10_000 });

    // The tiny crop keeps its draft and is flagged on the badge and the status line.
    await expect(page.getByTestId("suggestion-badge")).toHaveCount(3);
    await expect(page.getByTestId("suggestion-too-small")).toHaveCount(1);
    const status = page.getByTestId("suggestion-status");
    await expect(status).toContainText("3 drafts on this page");
    await expect(status).toContainText("1 with tiny crops");
    await expect(page.getByTestId("suggestion-lopsided")).toContainText(
      "van has 8x the images of none",
    );

    // Newest first by default, then the least sure event first.
    await expect(images.first()).toHaveAttribute("src", /sure01/);
    const toggle = page.getByTestId("train-order-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(images.first()).toHaveAttribute("src", /unsure1/);
    await expect(images.nth(1)).toHaveAttribute("src", /tiny01/);
    await expect(images.last()).toHaveAttribute("src", /sure01/);
  });
});
