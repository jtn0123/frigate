/**
 * Fork: read-path error surfacing (report item C5).
 *
 * A 500 from a read endpoint used to render nothing. The System page now
 * shows an inline ErrorState with a retry button, and the global SWR
 * onError raises a toast (de-duplicated per endpoint).
 */

import { test, expect } from "../../fixtures/frigate-test";
import { mockError } from "../../helpers/mock-overrides";

test.describe("Read-path errors @high", () => {
  test.use({
    expectedErrors: [/500.*\/api\/stats(\?|$)|Failed to load resource.*500/],
  });

  test("System page shows an inline error state with retry when stats fail", async ({
    frigateApp,
  }) => {
    await mockError(frigateApp.page, "**/api/stats");
    await frigateApp.goto("/system#general");

    const state = frigateApp.page.getByTestId("fork-error-state").first();
    await expect(state).toBeVisible({ timeout: 10_000 });
    await expect(state).toContainText("Could not load this data");
    await expect(state.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("a failing read raises a toast naming the endpoint", async ({
    frigateApp,
  }) => {
    await mockError(frigateApp.page, "**/api/stats");
    await frigateApp.goto("/system#general");

    await expect(
      frigateApp.page.getByText("Failed to load stats (HTTP 500)"),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("retry refetches and clears the error state once the endpoint recovers", async ({
    frigateApp,
  }) => {
    let recovered = false;
    // While failing, answer 500; once recovered, fall back to the default
    // stats mock the fixture installed (handlers are LIFO, so this one wins
    // until it yields with route.fallback()).
    await frigateApp.page.route("**/api/stats", (route) => {
      if (recovered) {
        return route.fallback();
      }
      return route.fulfill({
        status: 500,
        json: { success: false, message: "Mocked error" },
      });
    });
    await frigateApp.goto("/system#general");
    const state = frigateApp.page.getByTestId("fork-error-state").first();
    await expect(state).toBeVisible({ timeout: 10_000 });

    recovered = true;
    await state.getByRole("button", { name: "Retry" }).click();
    await expect(frigateApp.page.getByTestId("fork-error-state")).toHaveCount(
      0,
      { timeout: 10_000 },
    );
    await expect(frigateApp.page.getByText("0.15.0-test")).toBeVisible();
  });

  test("@mobile inline error state renders on mobile", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile-only assertion");
    await mockError(frigateApp.page, "**/api/stats");
    await frigateApp.goto("/system#general");
    await expect(
      frigateApp.page.getByTestId("fork-error-state").first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
