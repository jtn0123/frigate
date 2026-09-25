/**
 * Fork (I41): suggested classes on the classification train grid.
 *
 * The grid asks /classification/{model}/suggestions for the events on the
 * page and shows a badge with the draft class. Confirm files every image of
 * the event through the fork's confirm endpoint.
 */

import type { Page, Route } from "@playwright/test";
import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";

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
    await expect(badge).toContainText("van?");
    await expect(badge.getByTestId("suggestion-confidence")).toHaveAttribute(
      "aria-label",
      "High confidence",
    );

    // The draft takes the card's bottom label row in place of "None".
    const card = page.getByRole("button").filter({ has: badge });
    await expect(card).not.toContainText("None");
    const cardBox = await card.boundingBox();
    const badgeBox = await badge.boundingBox();
    expect(badgeBox!.y).toBeGreaterThan(cardBox!.y + cardBox!.height / 2);

    // The class name opens a popover with the score, source and evidence.
    await badge.getByRole("button", { name: /why van/i }).click();
    const why = page.getByTestId("suggestion-why");
    await expect(why).toContainText("van · 97%");
    await expect(why).toContainText("From the AI helper");
    await expect(why).toContainText("a white van is parked");
    await expect(why.locator("mark")).toHaveText("van");
    await page.keyboard.press("Escape");
    await expect(why).toHaveCount(0);

    const status = page.getByTestId("suggestion-status");
    // Counts read in photos: the van event has two, the other one.
    await expect(status).toContainText("2 of 3 photos have a guess");
    // Jev and the kept rate live on the Stats page now.
    await expect(status).not.toContainText("Jev");
    await expect(status).not.toContainText("Kept");

    // The hint shows until dismissed.
    const hint = page.getByTestId("suggestion-hint");
    await expect(hint).toContainText("Tap the check if it is right");
    await hint.getByRole("button", { name: /got it/i }).click();
    await expect(hint).toHaveCount(0);

    await badge.getByRole("button", { name: /accept van/i }).click();

    await expect.poll(() => confirms.length).toBe(1);
    expect(confirms[0]).toEqual({
      event_id: EVENT_VAN,
      category: "van",
      training_files: [TRAIN[0], TRAIN[1]],
      source: "jev",
      score: 0.97,
      suggested_category: "van",
    });
    await expect(page.getByText(/accepted 2 images as van/i)).toBeVisible();
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
    // Wait for the detail image so .last() is not the grid card, whose badge
    // now carries its own popup trigger.
    await expect(page.locator('img[src*="/train/"]')).toHaveCount(2, {
      timeout: 10_000,
    });
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
    await expect(page.getByText(/accepted 1 image as suv/i)).toBeVisible();
  });

  test("accepts every guess on the page with progress and counts a repeat as done", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const confirms: Record<string, unknown>[] = [];
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    await mockTrainPage(frigateApp, {
      train: () => TRAIN,
      events: [
        event(EVENT_VAN, "A white van is parked."),
        event(EVENT_OTHER, "A gray SUV drives by."),
      ],
      suggestions: {
        ...SUGGESTIONS,
        suggestions: {
          ...SUGGESTIONS.suggestions,
          [EVENT_OTHER]: draft("suv", "jev", 0.93),
        },
      },
      onConfirm: async (body, route) => {
        confirms.push(body);
        if (confirms.length === 1) {
          // Hold the first call so the button's progress can be read.
          await firstHeld;
          return route.fulfill({
            json: { success: true, message: "ok", moved: ["x.png"] },
          });
        }
        // Filed meanwhile (another tab, the background worker): still done.
        return route.fulfill({
          status: 404,
          json: { success: false, message: "already accepted" },
        });
      },
    });

    await frigateApp.goto("/classification");
    await page.getByText(MODEL).first().click();
    const status = page.getByTestId("suggestion-status");
    await expect(status).toContainText("3 of 3 photos have a guess", {
      timeout: 10_000,
    });

    const fileAll = page.getByTestId("file-all");
    await expect(fileAll).toHaveText("Accept all 2 guesses");
    await fileAll.click();
    const dialog = page.getByTestId("file-all-dialog");
    await expect(dialog).toContainText("Accept 2 guesses?");
    await expect(dialog).toContainText(
      "Wrong ones can be moved later from that class's tab.",
    );
    await expect(page.getByTestId("file-all-preview")).toHaveText(
      /suv 1, van 1/i,
    );
    // No tiny photos on the page, so there is nothing to skip.
    await expect(page.getByTestId("file-all-skip-tiny")).toHaveCount(0);
    await dialog.getByRole("button", { name: /accept all 2 guesses/i }).click();

    await expect(fileAll).toHaveText("Accepting 0 of 2");
    await expect(fileAll).toBeDisabled();
    // Single accepts wait while the run is going.
    await expect(
      page.getByTestId("suggestion-badge").getByRole("button", {
        name: /accept/i,
      }),
    ).toHaveCount(2);
    for (const button of await page
      .getByTestId("suggestion-badge")
      .getByRole("button", { name: /accept/i })
      .all()) {
      await expect(button).toBeDisabled();
    }
    releaseFirst();

    await expect.poll(() => confirms.length).toBe(2);
    // The grid orders groups differently on phones; only the set matters.
    expect(confirms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: EVENT_VAN,
          category: "van",
          training_files: [TRAIN[0], TRAIN[1]],
          bulk: true,
        }),
        expect.objectContaining({
          event_id: EVENT_OTHER,
          category: "suv",
          training_files: [TRAIN[2]],
          bulk: true,
        }),
      ]),
    );
    await expect(page.getByText("Accepted 2 of 2 guesses")).toBeVisible();
  });

  test("skips guesses made only of tiny photos unless unchecked", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const confirms: Record<string, unknown>[] = [];
    const tiny = "1780673400.0-tiny01";
    const train = [...TRAIN, `${tiny}-1780673401.0-unknown-0.0.webp`];

    await mockTrainPage(frigateApp, {
      train: () => train,
      events: [
        event(EVENT_VAN, "A white van is parked."),
        event(EVENT_OTHER, "A gray SUV drives by."),
        event(tiny, "A gray SUV."),
      ],
      suggestions: {
        ...SUGGESTIONS,
        suggestions: {
          ...SUGGESTIONS.suggestions,
          [EVENT_OTHER]: draft("suv", "jev", 0.93),
          [tiny]: draft("suv", "text", null),
        },
        too_small: { [tiny]: [train[3]] },
      },
      onConfirm: (body, route) => {
        confirms.push(body);
        return route.fulfill({
          json: { success: true, message: "ok", moved: ["x.png"] },
        });
      },
    });

    await frigateApp.goto("/classification");
    await page.getByText(MODEL).first().click();
    const fileAll = page.getByTestId("file-all");
    await expect(fileAll).toHaveText("Accept all 2 guesses", {
      timeout: 10_000,
    });
    await fileAll.click();

    const dialog = page.getByTestId("file-all-dialog");
    const skip = page.getByTestId("file-all-skip-tiny");
    await expect(skip).toHaveAttribute("data-state", "checked");
    await expect(dialog).toContainText("Skip images too small to train well");
    await expect(page.getByTestId("file-all-preview")).toHaveText(
      /suv 1, van 1/i,
    );
    await skip.click();
    await expect(dialog).toContainText("Accept 3 guesses?");
    await expect(page.getByTestId("file-all-preview")).toHaveText(
      /suv 2, van 1/i,
    );
    await skip.click();
    await expect(dialog).toContainText("Accept 2 guesses?");
    await dialog.getByRole("button", { name: /accept all 2 guesses/i }).click();

    await expect(page.getByText("Accepted 2 of 2 guesses")).toBeVisible();
    expect(confirms.map((body) => body["event_id"]).sort()).toEqual(
      [EVENT_OTHER, EVENT_VAN].sort(),
    );
  });

  test("undoes a single accept from its toast", async ({ frigateApp }) => {
    const { page } = frigateApp;
    let train = [...TRAIN];
    const undos: unknown[] = [];

    await mockTrainPage(frigateApp, {
      train: () => train,
      events: [
        event(EVENT_VAN, "A white van is parked."),
        event(EVENT_OTHER, "Something drives by."),
      ],
      suggestions: SUGGESTIONS,
      onConfirm: (_body, route) => {
        train = train.filter((name) => !name.startsWith(EVENT_VAN));
        return route.fulfill({
          json: {
            success: true,
            message: "ok",
            moved: ["van-1.png", "van-2.png"],
          },
        });
      },
      onUndo: (body, route) => {
        undos.push(body);
        train = [...TRAIN];
        return route.fulfill({
          json: { success: true, message: "ok", restored: 2 },
        });
      },
    });

    await frigateApp.goto("/classification");
    await page.getByText(MODEL).first().click();
    const badge = page.getByTestId("suggestion-badge");
    await expect(badge).toHaveCount(1, { timeout: 10_000 });
    await badge.getByRole("button", { name: /accept van/i }).click();
    await expect(page.getByText(/accepted 2 images as van/i)).toBeVisible();
    await expect(badge).toHaveCount(0);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => undos.length).toBe(1);
    expect(undos[0]).toEqual({
      event_id: EVENT_VAN,
      category: "van",
      files: ["van-1.png", "van-2.png"],
    });
    await expect(page.getByText("Moved 2 images back")).toBeVisible();
    await expect(badge).toHaveCount(1);
  });

  test("does not flash the hint once it has been dismissed", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await mockTrainPage(frigateApp, {
      train: () => TRAIN,
      events: [
        event(EVENT_VAN, "A white van is parked."),
        event(EVENT_OTHER, "Something drives by."),
      ],
      suggestions: SUGGESTIONS,
    });

    await frigateApp.goto("/classification");
    await idbPut(page, { "fork.suggestionHintSeen": true });
    // Record whether the hint is ever drawn, even for one frame.
    await page.evaluate(() => {
      const w = window as unknown as { hintDrawn: boolean };
      w.hintDrawn = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="suggestion-hint"]')) {
          w.hintDrawn = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.getByText(MODEL).first().click();
    await expect(page.getByTestId("suggestion-status")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("suggestion-badge")).toHaveCount(1);
    expect(
      await page.evaluate(
        () => (window as unknown as { hintDrawn: boolean }).hintDrawn,
      ),
    ).toBe(false);
  });

  test("offers Train now once ten new photos are in", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let trained = 0;
    await mockTrainPage(frigateApp, {
      train: () => TRAIN,
      events: [
        event(EVENT_VAN, "A white van is parked."),
        event(EVENT_OTHER, "Something drives by."),
      ],
      suggestions: SUGGESTIONS,
      datasetChanged: true,
      report: {
        training: {
          has_trained: true,
          last_training_date: null,
          current_images: 40,
          new_images: 12,
        },
      },
      onTrain: () => {
        trained += 1;
      },
    });

    await frigateApp.goto("/classification");
    await page.getByText(MODEL).first().click();
    const trainNow = page.getByTestId("suggestion-train-now");
    await expect(trainNow).toHaveText("Train now (12 new photos)", {
      timeout: 10_000,
    });
    await trainNow.click();
    await expect.poll(() => trained).toBe(1);
    await expect(trainNow).toHaveCount(0);
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
    await expect(status).toContainText("3 of 3 photos have a guess");
    const tinyNote = "1 is a tiny photo: fine to accept, it teaches less";
    const lopsidedNote =
      "van has 8x more photos than none. Add more none photos before training.";

    // Newest first by default, then the least sure event first.
    await expect(images.first()).toHaveAttribute("src", /sure01/);
    if (frigateApp.isMobile) {
      // Phones keep the row to one line; the rest sits in the More menu.
      await expect(page.getByTestId("suggestion-small")).toBeHidden();
      await page.getByTestId("suggestion-more").click();
      const menu = page.getByRole("menu");
      await expect(menu).toContainText(tinyNote);
      await expect(menu).toContainText(lopsidedNote);
      await expect(
        menu.getByRole("menuitem", { name: "Stats" }),
      ).toHaveAttribute("href", `/classification/suggestions/${MODEL}`);
      const item = page.getByTestId("train-order-menu");
      await expect(item).toHaveAttribute("aria-checked", "false");
      await item.click();
    } else {
      await expect(page.getByTestId("suggestion-small")).toHaveText(tinyNote);
      await expect(page.getByTestId("suggestion-lopsided")).toHaveText(
        lopsidedNote,
      );
      const toggle = page.getByTestId("train-order-toggle");
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
    }
    await expect(images.first()).toHaveAttribute("src", /unsure1/);
    await expect(images.nth(1)).toHaveAttribute("src", /tiny01/);
    await expect(images.last()).toHaveAttribute("src", /sure01/);
  });
});

function draft(category: string, source: "jev" | "text", score: number | null) {
  return {
    text: source === "text" ? { category, source, score, evidence: "" } : null,
    jev: source === "jev" ? { category, source, score, evidence: "" } : null,
    jev_status: source === "jev" ? "answered" : "unknown",
    suggestion: { category, source, score, evidence: `a ${category}` },
    conflict: false,
  };
}

type TrainPageMocks = {
  train: () => string[];
  events: ReturnType<typeof event>[];
  suggestions: unknown;
  /** Merged into an empty report. */
  report?: Record<string, unknown>;
  /** Whether the dataset changed since training, which enables Train. */
  datasetChanged?: boolean;
  onConfirm?: (body: Record<string, unknown>, route: Route) => Promise<void>;
  onUndo?: (body: unknown, route: Route) => Promise<void>;
  onTrain?: () => void;
};

/** The model's train page with its suggestions, for the status line tests. */
async function mockTrainPage(frigateApp: FrigateApp, mocks: TrainPageMocks) {
  const { page } = frigateApp;
  await frigateApp.installDefaults({
    config: { classification: { custom: CUSTOM_MODELS } },
  });
  await page.route(
    new RegExp(`/api/classification/${MODEL}/dataset$`),
    (route) =>
      route.fulfill({
        json: {
          categories: { van: [], suv: [], none: [] },
          training_metadata: mocks.datasetChanged
            ? { dataset_changed: true, new_images_count: 12 }
            : undefined,
        },
      }),
  );
  await page.route(
    new RegExp(`/api/classification/${MODEL}/train$`),
    (route) => {
      if (route.request().method() === "POST") {
        mocks.onTrain?.();
        return route.fulfill({ json: { success: true } });
      }
      return route.fulfill({ json: mocks.train() });
    },
  );
  await page.route("**/api/event_ids**", (route) =>
    route.fulfill({ json: mocks.events }),
  );
  await page.route(
    new RegExp(`/api/classification/${MODEL}/suggestions\\?`),
    (route) => route.fulfill({ json: mocks.suggestions }),
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
          ...mocks.report,
        },
      }),
  );
  await page.route(
    new RegExp(`/api/classification/${MODEL}/suggestions/confirm`),
    (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (mocks.onConfirm) {
        return mocks.onConfirm(body, route);
      }
      return route.fulfill({
        json: { success: true, message: "ok", moved: ["x.png"] },
      });
    },
  );
  await page.route(
    new RegExp(`/api/classification/${MODEL}/suggestions/undo`),
    (route) => {
      const body: unknown = route.request().postDataJSON();
      if (mocks.onUndo) {
        return mocks.onUndo(body, route);
      }
      return route.fulfill({
        json: { success: true, message: "ok", restored: 0 },
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
}

// idb-keyval's default database, where use-persistence keeps its values
async function idbPut(page: Page, entries: Record<string, unknown>) {
  await page.evaluate(
    (values) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("keyval-store");
        open.onupgradeneeded = () => open.result.createObjectStore("keyval");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("keyval", "readwrite");
          const store = tx.objectStore("keyval");
          for (const [key, value] of Object.entries(values)) {
            store.put(value, key);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    entries,
  );
}
