/**
 * Viewport layout (fork flag `viewportLayout`) -- HIGH tier.
 *
 * The app shell picks the sidebar or the bottom bar from the window width
 * (Tailwind `md`, 768 px) instead of the user agent. Resizing across the
 * breakpoint must swap the shell without a reload, and turning the flag
 * off must restore the user-agent behaviour.
 */

import { test, expect } from "../../fixtures/frigate-test";
import { BasePage } from "../../pages/base.page";

const NARROW = { width: 600, height: 900 };
const WIDE_PHONE = { width: 900, height: 420 };

test.describe("Viewport layout — desktop window @high", () => {
  test.skip(
    ({ frigateApp }) => frigateApp.isMobile,
    "Starts from the desktop shell",
  );

  test("narrow window swaps the sidebar for the bottom bar", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    const base = new BasePage(page, true);
    await frigateApp.goto("/");
    await expect(base.sidebar).toBeVisible();
    await expect(base.pageRoot).toHaveClass(/left-\[52px\]/);

    await page.setViewportSize(NARROW);
    await expect(base.sidebar).toHaveCount(0);
    await expect(base.bottombar).toBeVisible();
    await expect(base.pageRoot).toHaveClass(/bottom-12/);
    await expect(page.locator('a[href="/review"]').first()).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(base.sidebar).toBeVisible();
    await expect(base.bottombar).toHaveCount(0);
  });

  test("bottom bar hides the desktop-only nav items", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    await frigateApp.goto("/");
    await expect(
      page.locator('a[href="/classification"]').first(),
    ).toBeVisible();

    await page.setViewportSize(NARROW);
    await expect(page.locator('a[href="/classification"]')).toHaveCount(0);
  });

  test("flag off keeps the user-agent shell in a narrow window", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    const base = new BasePage(page, true);
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "frigateFork",
        JSON.stringify({ viewportLayout: false }),
      );
    });
    await frigateApp.goto("/");
    await expect(base.sidebar).toBeVisible();

    await page.setViewportSize(NARROW);
    await expect(base.sidebar).toBeVisible();
    await expect(base.bottombar).toHaveCount(0);
  });
});

test.describe("Viewport layout — phone @high @mobile", () => {
  test.skip(({ frigateApp }) => !frigateApp.isMobile, "Mobile-only");

  test("landscape phone wider than md gets the sidebar", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    const base = new BasePage(page, false);
    await frigateApp.goto("/");
    await expect(base.sidebar).toHaveCount(0);
    await expect(base.bottombar).toBeVisible();

    await page.setViewportSize(WIDE_PHONE);
    await expect(base.sidebar).toBeVisible();
    await expect(base.bottombar).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(base.sidebar).toHaveCount(0);
    await expect(base.bottombar).toBeVisible();
  });

  test("flag off keeps the bottom bar in landscape", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    const base = new BasePage(page, false);
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "frigateFork",
        JSON.stringify({ viewportLayout: false }),
      );
    });
    await frigateApp.goto("/");
    await page.setViewportSize(WIDE_PHONE);
    await expect(base.sidebar).toHaveCount(0);
    await expect(base.bottombar).toBeVisible();
  });
});
