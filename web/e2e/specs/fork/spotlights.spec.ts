/**
 * Fork: Spotlights feed (UI144, gap item 4.2).
 *
 * `/spotlights` ranks the review items worth a look: GenAI threat levels,
 * critical and notable sounds, known faces and plates, loitering and alerts.
 * Each card says why it is there, grouping chips narrow the feed, and the
 * ordinary detections are counted and left to Review. Repeats of one subject
 * share a card, the feed renders a page at a time, and new activity waits
 * behind a button.
 */

import type { Request } from "@playwright/test";
import { test, expect } from "../../fixtures/frigate-test";
import type { FrigateApp } from "../../fixtures/frigate-test";
import {
  SPOTLIGHT_HIDDEN,
  SPOTLIGHT_ORDER,
  SPOTLIGHT_REPEATS,
  spotlightPlateEvents,
  spotlightRepeats,
  spotlightReviews,
  spotlightStreet,
  spotlightsConfig,
  type SpotlightReviewMock,
} from "../../fixtures/mock-data/fork-spotlights";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

async function openSpotlights(
  frigateApp: FrigateApp,
  path = "/spotlights",
  reviews: SpotlightReviewMock[] = spotlightReviews(NOW),
) {
  await frigateApp.installDefaults({
    config: spotlightsConfig(),
    reviews,
    events: spotlightPlateEvents(NOW),
  });
  await frigateApp.goto(path);
}

function card(frigateApp: FrigateApp, id: string) {
  return frigateApp.page.locator(
    `[data-testid="spotlight-card"][data-review-id="${id}"]`,
  );
}

async function feedOrder(frigateApp: FrigateApp) {
  return frigateApp.page
    .getByTestId("spotlight-card")
    .evaluateAll((cards) =>
      cards.map((element) => element.getAttribute("data-review-id")),
    );
}

/** Every `reviews/viewed` body the page posts, in order. */
async function recordViewed(frigateApp: FrigateApp) {
  const bodies: { ids: string[]; reviewed: boolean }[] = [];
  await frigateApp.page.route("**/api/reviews/viewed", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ json: { success: true } });
  });
  return bodies;
}

function isReviewList(request: Request) {
  return new URL(request.url()).pathname.endsWith("/api/review");
}

test.describe("Spotlights @high", () => {
  test("ranks the activity worth a look first and says why", async ({
    frigateApp,
  }) => {
    await openSpotlights(frigateApp);
    const { page } = frigateApp;

    await expect(
      page.getByRole("heading", { name: "Spotlights" }),
    ).toBeVisible();
    await expect(page.getByTestId("spotlight-card")).toHaveCount(
      SPOTLIGHT_ORDER.length,
    );
    await expect
      .poll(() => feedOrder(frigateApp))
      .toEqual([...SPOTLIGHT_ORDER]);

    const reasons = (id: string) =>
      card(frigateApp, id).getByTestId("spotlight-reason");
    // the reason that ranked it, not the same two status chips on every
    // card: unreviewed is the dot, and "Alert" only shows when it is the
    // reason the item is listed
    await expect(reasons("threat")).toHaveText(["Threat level 2"]);
    await expect(reasons("threat").first()).toHaveAttribute(
      "title",
      "Security concern",
    );
    await expect(reasons("glass")).toHaveText(["Glass break"]);
    await expect(reasons("alice")).toHaveText(["Known face: Alice"]);
    await expect(reasons("bob-car")).toHaveText([
      "Known vehicle: Bob's Tesla",
      "Plate 7KLM482",
    ]);
    await expect(reasons("plate")).toHaveText(["Alert", "Plate ABC123"]);
    await expect(reasons("loiter")).toHaveText(["Loitering: Back gate"]);
    await expect(reasons("siren")).toHaveText(["Siren"]);
    await expect(reasons("bob-face")).toHaveText(["Known face: Bob"]);
    await expect(
      card(frigateApp, "threat").getByTestId("spotlight-unreviewed"),
    ).toHaveAttribute("title", "Unreviewed");
    await expect(
      card(frigateApp, "bob-face").getByTestId("spotlight-unreviewed"),
    ).toHaveCount(0);

    // the GenAI title and description, and where it happened
    const threat = card(frigateApp, "threat");
    await expect(
      threat.getByRole("heading", { name: "Person tries the back gate" }),
    ).toBeVisible();
    await expect(threat).toContainText("pulls the latch twice");
    await expect(threat).toContainText("Backyard · Lawn");
    await expect(card(frigateApp, "bob-face")).toContainText("Reviewed");
    await expect(
      card(frigateApp, "bob-face").getByRole("button", {
        name: "Mark reviewed",
      }),
    ).toHaveCount(0);

    // the cat, the passerby and the parked car stay on Review
    for (const id of ["cat", "walker", "parked", "yesterday"]) {
      await expect(card(frigateApp, id)).toHaveCount(0);
    }
    await expect(page.getByTestId("spotlights-hidden")).toContainText(
      `${SPOTLIGHT_HIDDEN} other detections had nothing that stood out.`,
    );
  });

  test("asks /review for the chosen range, then plates for it", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const plates = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname.endsWith("/api/events") &&
        url.searchParams.get("recognized_license_plate") === ".+"
      );
    });
    const first = page.waitForRequest(isReviewList);
    await openSpotlights(frigateApp);
    const after = Number(
      new URL((await first).url()).searchParams.get("after"),
    );
    expect(Math.abs(after - (NOW - DAY))).toBeLessThan(180);
    expect(new URL((await plates).url()).searchParams.get("after")).toBe(
      String(after),
    );

    await expect(card(frigateApp, "yesterday")).toHaveCount(0);
    const wider = page.waitForRequest(isReviewList);
    await page
      .getByTestId("spotlights-range")
      .getByRole("radio", { name: "3 days" })
      .click();
    const widerAfter = Number(
      new URL((await wider).url()).searchParams.get("after"),
    );
    expect(Math.abs(widerAfter - (NOW - 3 * DAY))).toBeLessThan(180);
    await expect(page).toHaveURL(/range=3d/);
    await expect(card(frigateApp, "yesterday")).toBeVisible();

    // back to the default drops the parameter
    await page
      .getByTestId("spotlights-range")
      .getByRole("radio", { name: "24 hours" })
      .click();
    await expect(page).not.toHaveURL(/range=/);
    await expect(card(frigateApp, "yesterday")).toHaveCount(0);
  });

  test("grouping chips narrow the feed and keep it in the URL", async ({
    frigateApp,
  }) => {
    await openSpotlights(frigateApp);
    const { page } = frigateApp;
    const chip = (name: string) =>
      page.getByTestId(`spotlights-category-${name}`);

    await expect(chip("all")).toHaveAttribute("aria-pressed", "true");
    await expect(chip("all")).toContainText(String(SPOTLIGHT_ORDER.length));
    await expect(chip("people")).toContainText("2");
    await expect(chip("vehicles")).toContainText("2");
    await expect(chip("threats")).toContainText("4");
    await expect(chip("unreviewed")).toContainText("4");

    await chip("people").click();
    await expect(page).toHaveURL(/group=people/);
    await expect(chip("people")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("spotlight-card")).toHaveCount(2);
    await expect
      .poll(() => feedOrder(frigateApp))
      .toEqual(["alice", "bob-face"]);

    await chip("threats").click();
    await expect
      .poll(() => feedOrder(frigateApp))
      .toEqual(["threat", "glass", "loiter", "siren"]);

    // a second click on the selected chip shows everything again
    await chip("threats").click();
    await expect(page).not.toHaveURL(/group=/);
    await expect(page.getByTestId("spotlight-card")).toHaveCount(
      SPOTLIGHT_ORDER.length,
    );
  });

  test("the camera filter narrows the feed", async ({ frigateApp }) => {
    await openSpotlights(frigateApp);
    const { page } = frigateApp;
    await expect(page.getByTestId("spotlight-card")).toHaveCount(
      SPOTLIGHT_ORDER.length,
    );

    const narrowed = page.waitForRequest(
      (request) =>
        isReviewList(request) &&
        new URL(request.url()).searchParams.get("cameras") === "garage",
    );
    await page.getByLabel("Cameras Filter").first().click();
    await page.getByRole("switch", { name: "Garage" }).click();
    await page.getByRole("button", { name: "Apply" }).click();
    await narrowed;
    await expect(page).toHaveURL(/cameras=garage/);
    await expect
      .poll(() => feedOrder(frigateApp))
      .toEqual(["glass", "bob-car", "plate"]);
  });

  test("mark reviewed keeps the card in place and can be undone", async ({
    frigateApp,
  }) => {
    await openSpotlights(frigateApp);
    const { page } = frigateApp;
    const viewed = await recordViewed(frigateApp);
    const threat = card(frigateApp, "threat");

    await threat.getByRole("button", { name: "Mark reviewed" }).click();
    await expect(page.getByText("Marked as reviewed")).toBeVisible();
    expect(viewed).toEqual([{ ids: ["threat"], reviewed: true }]);
    await expect(threat.getByTestId("spotlight-reviewed")).toBeVisible();
    await expect(threat.getByTestId("spotlight-unreviewed")).toHaveCount(0);
    await expect(threat.getByTestId("spotlight-reason")).toHaveText([
      "Threat level 2",
    ]);
    await expect(
      threat.getByRole("button", { name: "Mark reviewed" }),
    ).toHaveCount(0);
    // the feed does not reshuffle under the pointer
    expect((await feedOrder(frigateApp)).at(0)).toBe("threat");
    await expect(
      page.getByTestId("spotlights-category-unreviewed"),
    ).toContainText("3");

    await page.getByRole("button", { name: "Undo" }).click();
    await expect
      .poll(() => viewed.at(-1))
      .toEqual({ ids: ["threat"], reviewed: false });
    await expect(
      threat.getByRole("button", { name: "Mark reviewed" }),
    ).toBeVisible();
    await expect(threat.getByTestId("spotlight-reviewed")).toHaveCount(0);
    await expect(threat.getByTestId("spotlight-unreviewed")).toBeVisible();
  });

  test("a failed update says so and leaves the item unreviewed", async ({
    frigateApp,
  }) => {
    await openSpotlights(frigateApp);
    const { page } = frigateApp;
    await page.route("**/api/reviews/viewed", (route) =>
      route.fulfill({ status: 500, json: { success: false } }),
    );
    const glass = card(frigateApp, "glass");
    await glass.getByRole("button", { name: "Mark reviewed" }).click();
    await expect(
      page.getByText("Could not update the review status"),
    ).toBeVisible();
    await expect(
      glass.getByRole("button", { name: "Mark reviewed" }),
    ).toBeVisible();
  });

  test("View in History opens the item on Review and marks it seen", async ({
    frigateApp,
  }) => {
    await openSpotlights(frigateApp);
    const { page } = frigateApp;
    const viewed = await recordViewed(frigateApp);
    await page.route("**/api/review/alice", (route) =>
      route.fulfill({ json: null }),
    );
    const lookup = page.waitForRequest("**/api/review/alice");

    await card(frigateApp, "alice")
      .getByRole("button", { name: "View in History" })
      .click();
    await lookup;
    await expect(page).toHaveURL(/\/review/);
    expect(viewed).toEqual([{ ids: ["alice"], reviewed: true }]);
  });

  test("Find similar opens Explore's similarity search", async ({
    frigateApp,
  }) => {
    await openSpotlights(frigateApp);
    await expect(
      card(frigateApp, "alice").getByRole("link", { name: "Find similar" }),
    ).toHaveAttribute(
      "href",
      "/explore?search_type=similarity&event_id=ev-alice",
    );
    // a sound has no tracked object to compare
    await expect(
      card(frigateApp, "glass").getByRole("link", { name: "Find similar" }),
    ).toHaveCount(0);
  });

  test("a quiet day shows the empty state and the count left to Review", async ({
    frigateApp,
  }) => {
    const ordinary = spotlightReviews(NOW).filter((review) =>
      ["cat", "walker", "parked"].includes(review.id),
    );
    await openSpotlights(frigateApp, "/spotlights", ordinary);
    const { page } = frigateApp;

    const empty = page.getByTestId("spotlights-empty");
    await expect(empty).toContainText("Nothing stood out");
    await expect(
      empty.getByRole("link", { name: "Open Review" }),
    ).toBeVisible();
    await expect(page.getByTestId("spotlights-hidden")).toContainText(
      "3 other detections had nothing that stood out.",
    );
    await expect(page.getByTestId("spotlights-category-people")).toBeDisabled();
  });

  test("an empty group offers to show everything", async ({ frigateApp }) => {
    const noPeople = spotlightReviews(NOW).filter(
      (review) => review.id === "glass",
    );
    await openSpotlights(frigateApp, "/spotlights?group=people", noPeople);
    const { page } = frigateApp;

    const empty = page.getByTestId("spotlights-empty");
    await expect(empty).toContainText("Nothing in this group");
    await empty.getByRole("button", { name: "Show everything" }).click();
    await expect(page).not.toHaveURL(/group=/);
    await expect.poll(() => feedOrder(frigateApp)).toEqual(["glass"]);
  });

  test("shows a skeleton until the review items arrive", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      config: spotlightsConfig(),
      events: spotlightPlateEvents(NOW),
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/review(\?|$)/, async (route) => {
      await gate;
      await route.fulfill({ json: spotlightReviews(NOW) });
    });
    await frigateApp.goto("/spotlights");

    await expect(page.getByTestId("spotlights-loading")).toBeVisible();
    release();
    await expect(page.getByTestId("spotlights-feed")).toBeVisible();
    await expect(page.getByTestId("spotlights-loading")).toHaveCount(0);
  });

  test("repeats share a card and the feed renders a page at a time", async ({
    frigateApp,
  }) => {
    const street = 60;
    await openSpotlights(frigateApp, "/spotlights", [
      ...spotlightReviews(NOW),
      ...spotlightRepeats(NOW),
      ...spotlightStreet(NOW, street),
    ]);
    const { page } = frigateApp;
    const cards = page.getByTestId("spotlight-card");
    const chip = (name: string) =>
      page.getByTestId(`spotlights-category-${name}`);

    // the ninety alerts of one tracked person are one card, led by the
    // newest, right after the threat and the glass break
    const total = SPOTLIGHT_ORDER.length + 1 + street;
    await expect(chip("all")).toContainText(String(total));
    await expect
      .poll(async () => (await feedOrder(frigateApp)).slice(0, 4))
      .toEqual(["threat", "glass", "repeat-0", "alice"]);
    const repeats = card(frigateApp, "repeat-0");
    await expect(repeats.getByTestId("spotlight-repeats")).toHaveText(
      `Seen ${SPOTLIGHT_REPEATS - 1} more times`,
    );
    await expect(card(frigateApp, "repeat-1")).toHaveCount(0);
    await expect(chip("people")).toContainText("3");
    // a person alert with a passing car is not a vehicle sighting
    await expect(chip("vehicles")).toContainText("2");

    // one page of cards, not all of them
    await expect(cards).toHaveCount(24);
    const more = page.getByTestId("spotlights-more");
    await expect(more).toHaveText(`Show more (${total - 24} left)`);
    await more.click();
    await expect(cards).toHaveCount(48);
    await more.click();
    await expect(cards).toHaveCount(total);
    await expect(more).toHaveCount(0);

    // another group starts back at one page
    await chip("unreviewed").click();
    await expect(cards).toHaveCount(24);

    // the rest of the visit, newest first, one tap from History
    await chip("unreviewed").click();
    const toggle = repeats.getByTestId("spotlight-repeats");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const rows = repeats.getByTestId("spotlight-repeat");
    await expect(rows).toHaveCount(SPOTLIGHT_REPEATS - 1);
    await expect(rows.first()).toHaveAttribute("data-review-id", "repeat-1");

    // marking the card marks the whole visit
    const viewed = await recordViewed(frigateApp);
    await repeats
      .getByRole("button", { name: `Mark ${SPOTLIGHT_REPEATS} reviewed` })
      .click();
    await expect.poll(() => viewed.at(0)?.ids.length).toBe(SPOTLIGHT_REPEATS);
    expect(viewed.at(0)?.reviewed).toBe(true);
    await expect(repeats.getByTestId("spotlight-reviewed")).toBeVisible();
    await expect(
      page.getByText(`Marked ${SPOTLIGHT_REPEATS} items as reviewed`),
    ).toBeVisible();
  });

  test("hides the unreviewed chip while it holds every card", async ({
    frigateApp,
  }) => {
    const alerts = spotlightReviews(NOW).filter((review) =>
      ["threat", "glass", "alice"].includes(review.id),
    );
    await openSpotlights(frigateApp, "/spotlights", alerts);
    const { page } = frigateApp;
    await expect(page.getByTestId("spotlights-category-all")).toContainText(
      "3",
    );
    await expect(page.getByTestId("spotlights-category-threats")).toBeVisible();
    await expect(
      page.getByTestId("spotlights-category-unreviewed"),
    ).toHaveCount(0);
  });

  test("new activity waits behind a button instead of moving cards", async ({
    frigateApp,
  }) => {
    await openSpotlights(frigateApp);
    const { page } = frigateApp;
    await expect
      .poll(() => feedOrder(frigateApp))
      .toEqual([...SPOTLIGHT_ORDER]);

    const scream: SpotlightReviewMock = {
      id: "scream",
      camera: "backyard",
      has_been_reviewed: false,
      thumb_path: "/media/frigate/clips/review/thumb-backyard-scream.webp",
      start_time: NOW - 60,
      end_time: NOW - 20,
      severity: "alert",
      data: {
        audio: ["scream"],
        detections: [],
        objects: [],
        sub_labels: [],
        significant_motion_areas: [],
        zones: [],
      },
    };
    await page.route(/\/api\/review(\?|$)/, (route) =>
      route.fulfill({ json: [...spotlightReviews(NOW), scream] }),
    );
    // a refresh asks only for what ended lately, not the whole day again
    const refresh = page.waitForRequest((request) => {
      if (!isReviewList(request)) {
        return false;
      }
      const after = Number(new URL(request.url()).searchParams.get("after"));
      return after > NOW - 15 * 60;
    });
    frigateApp.ws.sendReview({ type: "end", before: scream, after: scream });
    await refresh;

    const fresh = page.getByTestId("spotlights-fresh");
    await expect(fresh).toHaveText("1 new item");
    expect(await feedOrder(frigateApp)).toEqual([...SPOTLIGHT_ORDER]);

    await fresh.click();
    await expect
      .poll(() => feedOrder(frigateApp))
      .toEqual([SPOTLIGHT_ORDER[0], "scream", ...SPOTLIGHT_ORDER.slice(1)]);
    await expect(fresh).toHaveCount(0);
    await expect(
      card(frigateApp, "scream").getByTestId("spotlight-reason"),
    ).toHaveText(["Scream"]);
    // the new card says so, and only it
    await expect(
      card(frigateApp, "scream").getByTestId("spotlight-new"),
    ).toHaveText("New");
    await expect(page.locator('[data-arrived="true"]')).toHaveCount(1);
  });

  test("a new item that ranks below the first page is opened and shown", async ({
    frigateApp,
  }) => {
    // thirty possible threats rank above any plain alert
    const threats = spotlightStreet(NOW, 30).map((item, index) => ({
      ...item,
      id: `threat-${index}`,
      data: {
        ...item.data,
        metadata: {
          title: "Person tries the side gate",
          scene: "",
          confidence: 0.9,
          potential_threat_level: 1,
        },
      },
    }));
    await openSpotlights(frigateApp, "/spotlights", threats);
    const { page } = frigateApp;
    await expect(page.getByTestId("spotlight-card")).toHaveCount(24);

    const [street] = spotlightStreet(NOW, 1);
    const plain: SpotlightReviewMock = {
      ...street!,
      id: "plain",
      start_time: NOW - 90,
      end_time: NOW - 40,
      data: { ...street!.data, detections: ["ev-plain"] },
    };
    await page.route(/\/api\/review(\?|$)/, (route) =>
      route.fulfill({ json: [...threats, plain] }),
    );
    frigateApp.ws.sendReview({ type: "end", before: plain, after: plain });
    const fresh = page.getByTestId("spotlights-fresh");
    await expect(fresh).toHaveText("1 new item");
    await fresh.click();

    // it ranks 31st: the feed opens far enough to show it and goes there,
    // instead of to the top where nothing changed
    const arrived = card(frigateApp, "plain");
    await expect(arrived).toHaveAttribute("data-arrived", "true");
    await expect(arrived.getByTestId("spotlight-new")).toHaveText("New");
    await expect(arrived).toBeInViewport();
    await expect(page.getByTestId("spotlight-card")).toHaveCount(31);
  });

  test.describe("when /review fails", () => {
    test.use({
      expectedErrors: [/500.*\/api\/review(\?|$)|Failed to load resource.*500/],
    });

    test("shows the error with a retry that recovers", async ({
      frigateApp,
    }) => {
      const { page } = frigateApp;
      await frigateApp.installDefaults({
        config: spotlightsConfig(),
        events: spotlightPlateEvents(NOW),
      });
      let recovered = false;
      await page.route(/\/api\/review(\?|$)/, (route) =>
        recovered
          ? route.fulfill({ json: spotlightReviews(NOW) })
          : route.fulfill({ status: 500, json: { success: false } }),
      );
      await frigateApp.goto("/spotlights");

      const state = page.getByTestId("fork-error-state");
      await expect(state).toBeVisible();
      recovered = true;
      await state.getByRole("button", { name: "Retry" }).click();
      await expect(page.getByTestId("spotlights-feed")).toBeVisible();
    });
  });

  test(
    "the rail and the command palette lead here",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.installDefaults({ config: spotlightsConfig() });
      await frigateApp.goto("/review");

      await page.getByRole("link", { name: "Spotlights" }).click();
      await expect(page).toHaveURL(/\/spotlights$/);
      await expect(page).toHaveTitle("Spotlights - Frigate");

      await frigateApp.goto("/");
      await page.keyboard.press("Control+k");
      await page
        .getByTestId("command-palette")
        .getByRole("combobox")
        .fill("Spotlights");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/spotlights$/);
    },
  );

  test(
    "one column on a phone, one tap into the Settings menu @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.installDefaults({
        config: spotlightsConfig(),
        reviews: spotlightReviews(NOW),
        events: spotlightPlateEvents(NOW),
      });
      await frigateApp.goto("/");

      // the bottom bar has no free slot, so the Settings menu, the phone's
      // overflow, leads there from its top
      await expect(page.getByRole("link", { name: "Spotlights" })).toHaveCount(
        0,
      );
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const entry = page.getByTestId("spotlights-menu-item");
      await expect(entry).toHaveAccessibleName("Spotlights");
      await entry.click();
      await expect(page).toHaveURL(/\/spotlights$/);
      await expect(entry).toHaveCount(0);

      const cards = page.getByTestId("spotlight-card");
      await expect(cards).toHaveCount(SPOTLIGHT_ORDER.length);
      const viewport = page.viewportSize()?.width ?? 0;
      const boxes = await cards.evaluateAll((elements) =>
        elements.slice(0, 3).map((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width };
        }),
      );
      // one shared left edge, nearly the full width, stacked top to bottom
      expect(new Set(boxes.map((box) => box.x)).size).toBe(1);
      for (const box of boxes) {
        expect(box.width).toBeGreaterThan(viewport * 0.85);
      }
      const tops = boxes.map((box) => box.y);
      expect(new Set(tops).size).toBe(tops.length);
      expect(tops).toEqual([...tops].sort((a, b) => a - b));

      // the chips scroll sideways instead of wrapping into a tall block
      const chips = page.getByRole("group", { name: "Show" });
      const chipHeight = await chips.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      expect(chipHeight).toBeLessThan(60);

      await card(frigateApp, "glass")
        .getByRole("button", { name: "Mark reviewed" })
        .click();
      await expect(
        card(frigateApp, "glass").getByTestId("spotlight-reviewed"),
      ).toBeVisible();
    },
  );
});
