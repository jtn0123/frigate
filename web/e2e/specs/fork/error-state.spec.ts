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

  test(
    "@mobile inline error state renders on mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await mockError(frigateApp.page, "**/api/stats");
      await frigateApp.goto("/system#general");
      await expect(
        frigateApp.page.getByTestId("fork-error-state").first(),
      ).toBeVisible({ timeout: 10_000 });
    },
  );
});

test.describe("Error toasts are readable @medium @mobile", () => {
  // UI47: error toasts sit on bg-danger, and their description used the
  // muted gray meant for neutral toasts, about 1.4:1 against the red.
  test("the description reaches 3:1 contrast on the red background", async ({
    frigateApp,
  }) => {
    await frigateApp.page.route("**/api/review/summary**", (route) =>
      route.fulfill({ status: 500, json: { message: "summary unavailable" } }),
    );
    await frigateApp.goto("/review");
    const description = frigateApp.page
      .locator('[data-sonner-toast][data-type="error"] [data-description]')
      .first();
    await expect(description).toBeVisible({ timeout: 10_000 });

    const ratio = await description.evaluate((el) => {
      const toastEl = el.closest("[data-sonner-toast]") as HTMLElement;
      const parse = (c: string) => {
        const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
        return { rgb: m.slice(0, 3), a: m[3] ?? 1 };
      };
      const bg = parse(getComputedStyle(toastEl).backgroundColor).rgb;
      const fg = parse(getComputedStyle(el).color);
      // blend a translucent text color over the background
      const mixed = fg.rgb.map((v, i) => v * fg.a + bg[i] * (1 - fg.a));
      const lum = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const [l1, l2] = [lum(mixed), lum(bg)].sort((a, b) => b - a);
      return (l1 + 0.05) / (l2 + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(3);
  });
});
