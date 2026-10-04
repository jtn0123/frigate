/**
 * Fork (UI145): "Seen on other cameras" in the tracked object detail.
 *
 * A recognized face (sub label) or plate is looked up on the other cameras
 * within a window around the object's time. The panel draws one lane per
 * camera and thumbnails that open the sighting in Explore; with semantic
 * search on, CLIP look-alikes follow, marked approximate. The filtering
 * events route lets the specs check the queries and the answers together.
 */

import type { Locator } from "@playwright/test";
import { test, expect } from "../../fixtures/frigate-test";
import {
  installSeenElsewhereRoutes,
  trackedObject,
} from "../../fixtures/mock-data/fork-seen-elsewhere";
import { viewerProfile } from "../../fixtures/mock-data/profile";

// 2026-06-05 16:30 UTC
const T = 1780677000;

const ALICE_FRONT = trackedObject("alice-front", "front_door", "person", T, {
  subLabel: "Alice",
});
const ALICE_GARAGE = trackedObject(
  "alice-garage",
  "garage",
  "person",
  T + 180,
  { subLabel: "Alice" },
);
const ALICE_BACKYARD = trackedObject(
  "alice-backyard",
  "backyard",
  "person",
  T + 600,
  { subLabel: "Alice" },
);
// outside half an hour, inside an hour
const ALICE_LATER = trackedObject(
  "alice-later",
  "garage",
  "person",
  T + 45 * 60,
  { subLabel: "Alice" },
);
// the same camera never counts as "elsewhere"
const ALICE_FRONT_AGAIN = trackedObject(
  "alice-front-2",
  "front_door",
  "person",
  T + 300,
  { subLabel: "Alice" },
);
const BOB = trackedObject("bob-garage", "garage", "person", T + 120, {
  subLabel: "Bob",
});
const CAROL = trackedObject("carol-front", "front_door", "person", T + 4000, {
  subLabel: "Carol",
});
const STRANGER = trackedObject("stranger", "front_door", "person", T + 9000);
const CAR_GARAGE = trackedObject("car-garage", "garage", "car", T + 1000, {
  plate: "8ABC123",
});
const CAR_BACKYARD = trackedObject(
  "car-backyard",
  "backyard",
  "car",
  T + 1240,
  { plate: "8ABC123" },
);
const OTHER_CAR = trackedObject("other-car", "backyard", "car", T + 1100, {
  plate: "5XYZ999",
});

const EVENTS = [
  ALICE_FRONT,
  ALICE_GARAGE,
  ALICE_BACKYARD,
  ALICE_LATER,
  ALICE_FRONT_AGAIN,
  BOB,
  CAROL,
  STRANGER,
  CAR_GARAGE,
  CAR_BACKYARD,
  OTHER_CAR,
];

const LOOKALIKES = [
  // already found by face, so not repeated as a look-alike
  { ...ALICE_GARAGE, search_distance: 0.12 },
  {
    ...trackedObject("look-backyard", "backyard", "person", T + 400),
    search_distance: 0.22,
  },
  {
    ...trackedObject("look-garage", "garage", "person", T - 500),
    search_distance: 0.31,
  },
];

const SEMANTIC_SEARCH = { semantic_search: { enabled: true, model: "genai" } };

/** Each identity is read on both sides of the object, nearest first. */
function sides(log: { events: URLSearchParams[] }, subLabel: string) {
  const reads = log.events.filter((p) => p.get("sub_labels") === subLabel);
  return {
    earlier: reads.filter((p) => p.get("sort") === "date_desc"),
    later: reads.filter((p) => p.get("sort") === "date_asc"),
  };
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

type Box = Awaited<ReturnType<typeof boxOf>>;

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

test.describe("Seen on other cameras (fork UI145)", () => {
  test("follows a recognized face to the cameras it passed @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const log = await installSeenElsewhereRoutes(page, EVENTS);

    await frigateApp.goto("/explore?event_id=alice-front");
    await page.locator(`[data-start="${T}"]`).click();

    const panel = page.getByTestId("seen-elsewhere");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Seen on other cameras");
    await expect(
      panel.getByTestId("seen-elsewhere-identity-name"),
    ).toContainText("Alice");

    // one lane per camera, in the order Alice reached them
    const lanes = panel.getByTestId("seen-elsewhere-lane");
    await expect(lanes).toHaveCount(3);
    await expect(lanes.nth(0)).toHaveAttribute("data-camera", "front_door");
    await expect(lanes.nth(1)).toHaveAttribute("data-camera", "garage");
    await expect(lanes.nth(2)).toHaveAttribute("data-camera", "backyard");
    await expect(panel.getByTestId("seen-elsewhere-mark-current")).toHaveCount(
      1,
    );
    await expect(panel.getByTestId("seen-elsewhere-mark")).toHaveCount(2);

    const cards = panel
      .getByTestId("seen-elsewhere-matched")
      .getByTestId("seen-elsewhere-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("Garage");
    await expect(cards.nth(0)).toContainText("3 min later");
    await expect(cards.nth(1)).toContainText("Backyard");
    await expect(cards.nth(1)).toContainText("10 min later");
    await expect(panel).toContainText("2 sightings by face or plate");

    // the queries: Alice on the other cameras, half an hour either side,
    // split at the object's start so each side keeps its nearest sightings
    const { earlier, later } = sides(log, "Alice");
    expect(earlier[0]?.get("cameras")).toBe("backyard,garage");
    expect(Number(earlier[0]?.get("after"))).toBe(T - 1800);
    expect(Number(earlier[0]?.get("before"))).toBe(T + 1);
    expect(earlier[0]?.get("limit")).toBe("50");
    expect(later[0]?.get("cameras")).toBe("backyard,garage");
    expect(Number(later[0]?.get("after"))).toBe(T);
    expect(Number(later[0]?.get("before"))).toBe(T + 25 + 1800);
    expect(later[0]?.get("limit")).toBe("50");
    // semantic search is off, so no look-alikes are asked for
    expect(log.similar).toHaveLength(0);
    await expect(panel.getByTestId("seen-elsewhere-similar")).toHaveCount(0);
  });

  test("a wider window finds more and is remembered", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const log = await installSeenElsewhereRoutes(page, EVENTS);

    await frigateApp.goto("/explore?event_id=alice-front");
    await page.locator(`[data-start="${T}"]`).click();

    const panel = page.getByTestId("seen-elsewhere");
    const cards = panel
      .getByTestId("seen-elsewhere-matched")
      .getByTestId("seen-elsewhere-card");
    await expect(cards).toHaveCount(2);
    await expect(
      panel.getByRole("radio", { name: "Within 30 minutes" }),
    ).toHaveAttribute("aria-checked", "true");

    await panel.getByRole("radio", { name: "Within 1 hour" }).click();
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(2)).toContainText("45 min later");
    expect(
      log.events.some(
        (p) =>
          p.get("sub_labels") === "Alice" &&
          Number(p.get("after")) === T - 3600,
      ),
    ).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("frigateFork.seenElsewhereWindow"),
        ),
      )
      .toBe('"1h"');

    await panel.getByRole("radio", { name: "The same day" }).click();
    // the two sides together span the calendar day
    await expect
      .poll(() => {
        const { earlier, later } = sides(log, "Alice");
        return earlier.some((e) =>
          later.some(
            (l) => Number(l.get("before")) - Number(e.get("after")) === 86400,
          ),
        );
      })
      .toBe(true);
    await expect(cards).toHaveCount(3);
  });

  test("keeps the last answer in view while a new window loads", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await installSeenElsewhereRoutes(page, EVENTS);
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // registered last, so it runs first: hold both sides of the one-hour
    // window only
    await page.route(/\/api\/events\?/, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (
        Number(params.get("after")) === T - 3600 ||
        Number(params.get("before")) === T + 25 + 3600
      ) {
        await hold;
      }
      return route.fallback();
    });

    await frigateApp.goto("/explore?event_id=alice-front");
    await page.locator(`[data-start="${T}"]`).click();

    const panel = page.getByTestId("seen-elsewhere");
    const cards = panel
      .getByTestId("seen-elsewhere-matched")
      .getByTestId("seen-elsewhere-card");
    await expect(cards).toHaveCount(2);
    await expect(panel).toHaveAttribute("aria-busy", "false");

    await panel.getByRole("radio", { name: "Within 1 hour" }).click();
    // the half-hour sightings stay while the hour loads, with no placeholder
    await expect(panel).toHaveAttribute("aria-busy", "true");
    await expect(panel.getByTestId("seen-elsewhere-loading")).toHaveCount(0);
    await expect(cards).toHaveCount(2);

    release();
    await expect(panel).toHaveAttribute("aria-busy", "false");
    await expect(cards).toHaveCount(3);
  });

  test("follows a plate and opens another sighting", async ({ frigateApp }) => {
    const { page } = frigateApp;
    const log = await installSeenElsewhereRoutes(page, EVENTS);

    await frigateApp.goto("/explore?labels=car");
    await page.locator(`[data-start="${T + 1000}"]`).click();

    const panel = page.getByTestId("seen-elsewhere");
    await expect(
      panel.getByTestId("seen-elsewhere-identity-plate"),
    ).toContainText("8ABC123");
    const card = panel.getByTestId("seen-elsewhere-card");
    // the other car on the backyard has a different plate
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Backyard");
    await expect(card).toContainText("4 min later");
    const query = log.events.find(
      (p) => p.get("recognized_license_plate") === "8ABC123",
    );
    expect(query?.get("cameras")).toBe("backyard,front_door");
    expect(query?.has("sub_labels")).toBe(false);

    await card.click();
    await expect(page).toHaveURL(/event_id=car-backyard/);
    // the backyard car's own panel looks back at the garage
    await expect(panel.getByTestId("seen-elsewhere-card")).toContainText(
      "Garage",
    );
    await expect(panel.getByTestId("seen-elsewhere-card")).toContainText(
      "4 min earlier",
    );

    // the jump replaced the open object, so back returns to the cars
    await page.goBack();
    await expect(page).toHaveURL(/labels=car/);
    await expect(panel).toHaveCount(0);
    await expect(page.locator(`[data-start="${T + 1240}"]`)).toBeVisible();
  });

  test("adds approximate look-alikes when semantic search is on", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({ config: SEMANTIC_SEARCH });
    const log = await installSeenElsewhereRoutes(page, EVENTS, {
      similar: LOOKALIKES,
    });

    await frigateApp.goto("/explore?event_id=alice-front");
    await page.locator(`[data-start="${T}"]`).click();

    const panel = page.getByTestId("seen-elsewhere");
    const similar = panel.getByTestId("seen-elsewhere-similar");
    await expect(similar).toBeVisible();
    await expect(similar).toContainText("Similar appearance");
    await expect(similar).toContainText("Approximate");
    const cards = similar.getByTestId("seen-elsewhere-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("Backyard");
    await expect(cards.nth(0)).toContainText("78% alike");
    await expect(cards.nth(1)).toContainText("Garage");
    await expect(cards.nth(1)).toContainText("8 min earlier");
    // the face match stays a face match
    await expect(
      panel
        .getByTestId("seen-elsewhere-matched")
        .getByTestId("seen-elsewhere-card"),
    ).toHaveCount(2);
    await expect(
      panel.locator('[data-testid="seen-elsewhere-mark"][data-kind="similar"]'),
    ).toHaveCount(2);
    await expect(panel).toContainText("Looks alike");

    const query = log.similar[0];
    expect(query?.get("event_id")).toBe("alice-front");
    expect(query?.get("labels")).toBe("person");
    expect(query?.get("cameras")).toBe("backyard,garage");
  });

  test("an object without a face or plate gets look-alikes only", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({ config: SEMANTIC_SEARCH });
    const log = await installSeenElsewhereRoutes(page, EVENTS);

    await frigateApp.goto("/explore?event_id=stranger");
    await page.locator(`[data-start="${T + 9000}"]`).click();

    const panel = page.getByTestId("seen-elsewhere");
    await expect(panel.getByTestId("seen-elsewhere-empty")).toContainText(
      "Nothing that looks like this on other cameras within 30 minutes.",
    );
    await expect(panel.getByTestId("seen-elsewhere-identity-name")).toHaveCount(
      0,
    );
    await expect.poll(() => log.similar.length).toBeGreaterThan(0);
    expect(
      log.events.some(
        (p) => p.has("sub_labels") || p.has("recognized_license_plate"),
      ),
    ).toBe(false);
  });

  test("says so when nobody else saw the face", async ({ frigateApp }) => {
    const { page } = frigateApp;
    await installSeenElsewhereRoutes(page, EVENTS);

    await frigateApp.goto("/explore?event_id=carol-front");
    await page.locator(`[data-start="${T + 4000}"]`).click();

    const empty = page.getByTestId("seen-elsewhere-empty");
    await expect(empty).toContainText(
      "Not seen on other cameras within 30 minutes.",
    );
    await expect(empty).toContainText("Pick a wider window to look further.");
    await expect(page.getByTestId("seen-elsewhere-strip")).toHaveCount(0);
  });

  test("shows a placeholder while it looks", async ({ frigateApp }) => {
    const { page } = frigateApp;
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await installSeenElsewhereRoutes(page, EVENTS, { holdIdentity: hold });

    await frigateApp.goto("/explore?event_id=alice-front");
    await page.locator(`[data-start="${T}"]`).click();

    const panel = page.getByTestId("seen-elsewhere");
    await expect(panel.getByTestId("seen-elsewhere-loading")).toBeVisible();
    release();
    await expect(panel.getByTestId("seen-elsewhere-loading")).toHaveCount(0);
    await expect(panel.getByTestId("seen-elsewhere-card")).toHaveCount(2);
  });

  test.describe("when the lookup fails", () => {
    test.use({
      expectedErrors: [/500.*\/api\/events\?|Failed to load resource.*500/],
    });

    test("says it could not look", async ({ frigateApp }) => {
      const { page } = frigateApp;
      await installSeenElsewhereRoutes(page, EVENTS, { failIdentity: true });

      await frigateApp.goto("/explore?event_id=alice-front");
      await page.locator(`[data-start="${T}"]`).click();

      await expect(page.getByTestId("seen-elsewhere")).toContainText(
        "Could not look on the other cameras.",
      );
    });
  });

  test("tells an admin what would let it look, with a link to the setting", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const log = await installSeenElsewhereRoutes(page, EVENTS);

    await frigateApp.goto("/explore?event_id=stranger");
    await page.locator(`[data-start="${T + 9000}"]`).click();

    // no face, no plate and no semantic search: nothing it could look for,
    // so one line in its place says which features would change that
    await expect(page.getByTestId("seen-elsewhere")).toHaveCount(0);
    const setup = page.getByTestId("seen-elsewhere-setup");
    await expect(setup).toHaveText(
      "Turn on face recognition or semantic search to find this person on other cameras.",
    );
    await expect(
      setup.getByRole("link", { name: "semantic search" }),
    ).toHaveAttribute("href", "/settings?page=integrationSemanticSearch");
    expect(log.similar).toHaveLength(0);
    expect(log.events.some((p) => p.has("sub_labels"))).toBe(false);

    await setup.getByRole("link", { name: "face recognition" }).click();
    await expect(page).toHaveURL(/\/settings\?page=integrationFaceRecognition/);
  });

  test("names plate recognition for a car", async ({ frigateApp }) => {
    const { page } = frigateApp;
    await installSeenElsewhereRoutes(page, [
      ...EVENTS,
      trackedObject("plain-car", "garage", "car", T + 7000),
    ]);

    await frigateApp.goto("/explore?event_id=plain-car");
    await page.locator(`[data-start="${T + 7000}"]`).click();

    const setup = page.getByTestId("seen-elsewhere-setup");
    await expect(setup).toContainText(
      "Turn on license plate recognition or semantic search",
    );
    await expect(
      setup.getByRole("link", { name: "license plate recognition" }),
    ).toHaveAttribute("href", "/settings?page=integrationLpr");
  });

  test("stays out of a viewer's way without a face, plate or semantic search", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({ profile: viewerProfile() });
    const log = await installSeenElsewhereRoutes(page, EVENTS);

    await frigateApp.goto("/explore?event_id=stranger");
    await page.locator(`[data-start="${T + 9000}"]`).click();

    // the dialog is open, but a viewer cannot change settings: no line
    await expect(
      page.getByText("Tracked Object Details").first(),
    ).toBeVisible();
    await expect(page.getByTestId("seen-elsewhere")).toHaveCount(0);
    await expect(page.getByTestId("seen-elsewhere-setup")).toHaveCount(0);
    expect(log.similar).toHaveLength(0);
  });

  test(
    "describes the pointed-at sighting under the strip, clear of the controls",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await installSeenElsewhereRoutes(page, EVENTS);

      await frigateApp.goto("/explore?event_id=alice-front");
      await page.locator(`[data-start="${T}"]`).click();

      const panel = page.getByTestId("seen-elsewhere");
      const strip = panel.getByTestId("seen-elsewhere-strip");
      const readout = panel.getByTestId("seen-elsewhere-readout");
      const legend = panel.getByTestId("seen-elsewhere-legend");
      // the cards carry the same names, so look in the strip
      const garage = strip.getByRole("button", { name: /on Garage at/ });
      await expect(legend).toBeVisible();
      await expect(readout).toBeHidden();

      await garage.hover();
      await expect(readout).toContainText("Garage");
      await expect(readout).toContainText("3 min later");
      // the legend's row holds it, so nothing else moves or is covered
      await expect(legend).toBeHidden();
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      const shown = await boxOf(readout);
      expect(shown.y).toBeGreaterThanOrEqual(
        (await boxOf(strip)).y + (await boxOf(strip)).height,
      );
      for (const control of [
        panel.getByTestId("seen-elsewhere-window"),
        panel.getByTestId("seen-elsewhere-identity-name"),
        strip,
      ]) {
        expect(overlaps(shown, await boxOf(control))).toBe(false);
      }
      // and it stays inside the panel
      const inside = await boxOf(panel);
      expect(shown.x + shown.width).toBeLessThanOrEqual(
        inside.x + inside.width,
      );

      await page.mouse.move(0, 0);
      await expect(readout).toBeHidden();
      await expect(legend).toBeVisible();

      // the keyboard gets the same description
      const backyard = strip.getByRole("button", { name: /on Backyard at/ });
      await backyard.focus();
      await expect(readout).toBeVisible();
      await expect(readout).toContainText("Backyard");
      await expect(readout).toContainText("10 min later");
    },
  );

  test(
    "lets Tab walk from mark to mark and on to the cards",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await installSeenElsewhereRoutes(page, EVENTS);

      await frigateApp.goto("/explore?event_id=alice-front");
      await page.locator(`[data-start="${T}"]`).click();

      const panel = page.getByTestId("seen-elsewhere");
      const strip = panel.getByTestId("seen-elsewhere-strip");
      const readout = panel.getByTestId("seen-elsewhere-readout");
      const garage = strip.getByRole("button", { name: /on Garage at/ });
      const backyard = strip.getByRole("button", { name: /on Backyard at/ });

      // the readout swapping out mid-move once read to the dialog's focus
      // trap as focus lost, and Tab went back to the top of the dialog
      await garage.focus();
      await expect(readout).toContainText("Garage");
      await page.keyboard.press("Tab");
      await expect(backyard).toBeFocused();
      await expect(readout).toContainText("Backyard");
      // a ring a sighted keyboard user can see (the theme's ring is clear)
      await expect(backyard).not.toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Tab");
      const card = panel
        .getByTestId("seen-elsewhere-matched")
        .getByTestId("seen-elsewhere-card")
        .first();
      await expect(card).toBeFocused();
      await expect(card).not.toHaveCSS("box-shadow", "none");
      await expect(readout).toBeHidden();
      await expect(panel.getByTestId("seen-elsewhere-legend")).toBeVisible();
    },
  );

  test(
    "gives a fingertip room on a phone",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await installSeenElsewhereRoutes(page, EVENTS);

      await frigateApp.goto("/explore?event_id=alice-front");
      await page.locator(`[data-start="${T}"]`).click();

      const panel = page.getByTestId("seen-elsewhere");
      await expect(panel.getByTestId("seen-elsewhere-mark")).toHaveCount(2);
      // hit testing reads what is on screen
      await panel.getByTestId("seen-elsewhere-strip").scrollIntoViewIfNeeded();

      for (const radio of await panel.getByRole("radio").all()) {
        const box = await boxOf(radio);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }

      // a mark keeps its 12 px look but answers 22 px above and below its
      // middle, without reaching into the next lane's marks
      const marks = panel.getByTestId("seen-elsewhere-mark");
      const reach = await marks.evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          return {
            height: box.height,
            above: document.elementFromPoint(x, y - 20) === button,
            below: document.elementFromPoint(x, y + 20) === button,
          };
        }),
      );
      expect(reach).toEqual([
        { height: 12, above: true, below: true },
        { height: 12, above: true, below: true },
      ]);

      // no strip text below 12 px
      for (const text of [
        panel.getByTestId("seen-elsewhere-axis"),
        panel.getByTestId("seen-elsewhere-legend"),
      ]) {
        const size = await text.evaluate((el) =>
          Number.parseFloat(getComputedStyle(el).fontSize),
        );
        expect(size).toBeGreaterThanOrEqual(12);
      }
      // nor on the cards
      const offsets = await panel
        .getByTestId("seen-elsewhere-matched")
        .getByText(/min later$/)
        .evaluateAll((spans) =>
          spans.map((span) =>
            Number.parseFloat(getComputedStyle(span).fontSize),
          ),
        );
      expect(offsets).toEqual([12, 12]);
    },
  );

  test("is off with its flag", async ({ frigateApp }) => {
    const { page } = frigateApp;
    await page.addInitScript(() => {
      localStorage.setItem(
        "frigateFork",
        JSON.stringify({ seenElsewhere: false }),
      );
    });
    const log = await installSeenElsewhereRoutes(page, EVENTS);

    await frigateApp.goto("/explore?event_id=alice-front");
    await page.locator(`[data-start="${T}"]`).click();

    await expect(
      page.getByText("Tracked Object Details").first(),
    ).toBeVisible();
    await expect(page.getByTestId("seen-elsewhere")).toHaveCount(0);
    expect(log.events.some((p) => p.has("sub_labels"))).toBe(false);
  });
});
