/**
 * Fork: one search entry in the rail (UI134).
 *
 * The desktop rail used to carry a magnifier that jumped to Explore and a
 * separate command button. They are one button now: it opens the palette,
 * which looks through pages, cameras, settings and recorded footage at once.
 * Footage needs the semantic endpoint, so the group only searches when
 * `semantic_search.enabled` is set and says so plainly when it is not.
 */

import { test, expect } from "../../fixtures/frigate-test";
import type { FrigateApp } from "../../fixtures/frigate-test";
import { openPaletteOnPhone } from "../../helpers/phone-palette";

const SEMANTIC_CONFIG = {
  semantic_search: { enabled: true, model: "genai" },
} as const;

const RESULTS = [
  {
    id: "event-car-777",
    label: "car",
    sub_label: null,
    camera: "backyard",
    start_time: 1780677009.365581,
    end_time: 1780677039.365581,
    zones: [],
    has_clip: true,
    has_snapshot: true,
    score: 0.9,
    top_score: 0.9,
    search_source: "description",
    search_distance: 0.2,
    data: { type: "object", score: 0.9, top_score: 0.9 },
  },
];

async function openPalette(frigateApp: FrigateApp) {
  const { page } = frigateApp;
  if (frigateApp.isMobile) {
    await openPaletteOnPhone(page);
  } else {
    await page.getByTestId("nav-search").click();
  }
  await expect(page.getByTestId("command-palette")).toBeVisible();
}

test.describe("Rail search @high", () => {
  test(
    "rail tooltips explain destinations and unified search",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/review");
      const rail = page.locator("aside");
      await rail.getByRole("link", { name: "Live", exact: true }).hover();
      await expect(page.getByRole("tooltip")).toContainText(
        "Every camera, right now",
      );
      await rail.getByTestId("nav-search").hover();
      await expect(page.getByRole("tooltip")).toContainText(
        "Search footage, cameras, pages, and settings",
      );
    },
  );

  test(
    "the search button identifies Explore without losing palette access",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/explore");
      const search = page.getByTestId("nav-search");
      await expect(search).toHaveAttribute("aria-current", "page");
      await search.click();
      await expect(page.getByTestId("command-palette")).toBeVisible();
      await page.getByRole("combobox").fill("Review");
      await page.locator('[cmdk-item][data-value="page:review"]').click();
      await expect(page).toHaveURL(/\/review/);
      await expect(search).not.toHaveAttribute("aria-current", "page");
    },
  );

  test(
    "the rail carries one search button and no command button",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      const rail = frigateApp.page.locator("aside");
      await expect(rail.getByTestId("nav-search")).toHaveCount(1);
      await expect(rail.getByTestId("command-palette-hint")).toHaveCount(0);
      // the slot it replaced no longer links straight to Explore
      await expect(rail.locator('a[href="/explore"]')).toHaveCount(0);
    },
  );

  test(
    "the search button still reaches Explore through the palette",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/review");
      await openPalette(frigateApp);
      await frigateApp.page
        .locator("[cmdk-item]", { hasText: "Explore" })
        .first()
        .click();
      await expect(frigateApp.page).toHaveURL(/\/explore/);
    },
  );

  test("typing finds recorded footage and opens the clip @mobile", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({ config: SEMANTIC_CONFIG });
    const queries: string[] = [];
    await frigateApp.page.route("**/api/events/search**", (route) => {
      queries.push(
        new URL(route.request().url()).searchParams.get("query") ?? "",
      );
      return route.fulfill({ json: RESULTS });
    });

    await frigateApp.goto("/");
    await openPalette(frigateApp);
    await frigateApp.page.keyboard.type("red car");

    const result = frigateApp.page.getByTestId("footage-result").first();
    await expect(result).toBeVisible();
    await expect(result).toContainText("Backyard");
    expect(queries).toContain("red car");

    await result.click();
    await expect(frigateApp.page).toHaveURL(/event_id=event-car-777/);
  });

  test("see all hands the query to Explore @mobile", async ({ frigateApp }) => {
    await frigateApp.installDefaults({ config: SEMANTIC_CONFIG });
    await frigateApp.page.route("**/api/events/search**", (route) =>
      route.fulfill({ json: RESULTS }),
    );

    await frigateApp.goto("/");
    await openPalette(frigateApp);
    await frigateApp.page.keyboard.type("red car");
    await frigateApp.page.getByTestId("footage-see-all").click();
    await expect(frigateApp.page).toHaveURL(/\/explore\?query=red\+car/);
  });

  test("one request covers a word typed letter by letter @mobile", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({ config: SEMANTIC_CONFIG });
    let calls = 0;
    await frigateApp.page.route("**/api/events/search**", (route) => {
      calls += 1;
      return route.fulfill({ json: RESULTS });
    });

    await frigateApp.goto("/");
    await openPalette(frigateApp);
    await frigateApp.page.keyboard.type("car", { delay: 20 });
    await expect(frigateApp.page.getByTestId("footage-result")).toBeVisible();
    expect(calls).toBe(1);
  });

  test("without semantic search the group says so instead of failing @mobile", async ({
    frigateApp,
  }) => {
    let called = false;
    await frigateApp.page.route("**/api/events/search**", (route) => {
      called = true;
      return route.fulfill({ status: 400, json: { message: "disabled" } });
    });

    await frigateApp.goto("/");
    await openPalette(frigateApp);
    await frigateApp.page.keyboard.type("red car");

    const setup = frigateApp.page.getByTestId("footage-setup");
    await expect(setup).toBeVisible();
    expect(called).toBe(false);

    await setup.click();
    await expect(frigateApp.page).toHaveURL(/page=integrationSemanticSearch/);
  });
});
