/**
 * Fork: the harness's own navigation contract (item D49).
 *
 * `#pageRoot` belongs to the app shell, so it is in the DOM while the route
 * inside it is still suspended. The 32 i18n namespaces are fetched over HTTP
 * and react-i18next suspends until they land, so a slow locale response keeps
 * every translated accessible name out of the page. A navigation that
 * returned at `#pageRoot` handed that page to the test, where it read as
 * "element(s) not found" rather than as a page that had not finished.
 */

import { test, expect } from "../../fixtures/frigate-test";

/** Long enough that a navigation returning too early cannot miss it. */
const LOCALE_DELAY = 2_000;

/**
 * The namespace `/review` renders its own strings from. Only this one is
 * held back: the shell fetches all 29 in parallel, and delaying them all
 * kept `#pageRoot` itself off the page, which tests the wrong half of the
 * contract and blew the shell's budget on a loaded machine.
 */
const ROUTE_NAMESPACE = "**/locales/*/views/events.json*";

test.describe("harness: navigation readiness @meta", () => {
  test("goto() returns only once the suspense fallback is gone", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await page.route(ROUTE_NAMESPACE, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, LOCALE_DELAY));
      await route.fallback();
    });

    await frigateApp.goto("/review");

    // No polling: goto() has returned, so the page is ready now or never.
    expect(await page.getByTestId("page-loading").count()).toBe(0);
    await expect(page.getByLabel("Alerts")).toBeVisible({ timeout: 2_000 });
  });
});
