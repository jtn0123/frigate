/**
 * Fork: command palette (UI item 6).
 *
 * Cmd/Ctrl+K or "/" opens a cmdk palette with pages, cameras, camera groups,
 * settings sections and quick actions. Recent items persist in localStorage
 * and admin-only entries are hidden for viewers.
 */

import { test, expect } from "../../fixtures/frigate-test";
import type { FrigateApp } from "../../fixtures/frigate-test";
import { viewerProfile } from "../../fixtures/mock-data/profile";

async function openPalette(frigateApp: FrigateApp) {
  const { page } = frigateApp;
  if (frigateApp.isMobile) {
    await page.getByTestId("command-palette-hint").click();
  } else {
    await page.keyboard.press("Control+k");
  }
  await expect(page.getByTestId("command-palette")).toBeVisible();
}

function option(frigateApp: FrigateApp, text: string | RegExp) {
  return frigateApp.page.locator("[cmdk-item]", { hasText: text });
}

test.describe("Command palette @high", () => {
  test("Ctrl+K opens the palette with the main groups", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Keyboard shortcut flow");
    await frigateApp.goto("/");
    await frigateApp.page.keyboard.press("Control+k");
    const palette = frigateApp.page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await expect(palette.getByText("Pages", { exact: true })).toBeVisible();
    await expect(palette.getByText("Cameras", { exact: true })).toBeVisible();
    await expect(
      palette.getByText("Camera groups", { exact: true }),
    ).toBeVisible();
    await expect(palette.getByText("Actions", { exact: true })).toBeVisible();
    // Ctrl+K again closes it
    await frigateApp.page.keyboard.press("Control+k");
    await expect(palette).toBeHidden();
  });

  test("slash opens the palette when no input is focused", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Keyboard shortcut flow");
    await frigateApp.goto("/review");
    await frigateApp.page.keyboard.press("/");
    await expect(frigateApp.page.getByTestId("command-palette")).toBeVisible();
    // the search box takes focus so the slash itself is not typed
    await expect(
      frigateApp.page.getByPlaceholder(/Search pages, cameras/),
    ).toHaveValue("");
  });

  test("sidebar hint button opens the palette", async ({ frigateApp }) => {
    test.skip(frigateApp.isMobile, "Sidebar is desktop-only");
    await frigateApp.goto("/");
    const hint = frigateApp.page.getByTestId("command-palette-hint");
    await expect(hint).toHaveAttribute("aria-label", "Open command palette");
    await hint.click();
    await expect(frigateApp.page.getByTestId("command-palette")).toBeVisible();
  });

  test("filters cameras and jumps to the live view", async ({ frigateApp }) => {
    await frigateApp.goto("/review");
    await openPalette(frigateApp);
    await frigateApp.page.keyboard.type("backy");
    const live = option(frigateApp, "Backyard").filter({
      hasText: "Live view",
    });
    await expect(live).toBeVisible();
    await expect(option(frigateApp, "Garage")).toHaveCount(0);
    await live.click();
    await expect(frigateApp.page).toHaveURL(/\/#backyard$/);
    await expect(frigateApp.page.getByTestId("command-palette")).toBeHidden();
  });

  test("camera review entry deep links to review filtered by camera", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    await openPalette(frigateApp);
    await frigateApp.page.keyboard.type("front door review");
    const item = option(frigateApp, "Front Door").filter({ hasText: "Review" });
    await item.first().click();
    await expect(frigateApp.page).toHaveURL(/\/review/);
  });

  test("settings section deep links with ?page=", async ({ frigateApp }) => {
    await frigateApp.goto("/");
    await openPalette(frigateApp);
    await frigateApp.page.keyboard.type("motion tuner");
    await option(frigateApp, "Motion tuner").first().click();
    await expect(frigateApp.page).toHaveURL(/\/settings/);
    await expect(
      frigateApp.page.getByText("Motion tuner", { exact: true }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("recent items are remembered in localStorage", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    await openPalette(frigateApp);
    await frigateApp.page.keyboard.type("export");
    await option(frigateApp, "Export").first().click();
    await expect(frigateApp.page).toHaveURL(/\/export/);

    const stored = await frigateApp.page.evaluate(() =>
      JSON.parse(localStorage.getItem("frigateFork.recentCommands") ?? "[]"),
    );
    expect(stored).toEqual(["page:export"]);

    await openPalette(frigateApp);
    const palette = frigateApp.page.getByTestId("command-palette");
    await expect(palette.getByText("Recent", { exact: true })).toBeVisible();
    await expect(
      palette
        .locator("[cmdk-group]", { hasText: "Recent" })
        .locator("[cmdk-item]", { hasText: "Export" }),
    ).toBeVisible();
  });

  test("toggle theme action flips the root class", async ({ frigateApp }) => {
    await frigateApp.goto("/");
    const isDark = () =>
      frigateApp.page.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      );
    const before = await isDark();
    await openPalette(frigateApp);
    await frigateApp.page.keyboard.type("theme");
    await option(frigateApp, "Toggle dark / light theme").click();
    await expect.poll(isDark).toBe(!before);
  });

  test("mark all as reviewed posts the unreviewed ids", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    const posted: unknown[] = [];
    await frigateApp.page.route("**/api/reviews/viewed", (route) => {
      posted.push(route.request().postDataJSON());
      return route.fulfill({ json: { success: true } });
    });
    await openPalette(frigateApp);
    await frigateApp.page.keyboard.type("mark all");
    await option(frigateApp, "Mark all as reviewed").click();
    await expect(
      frigateApp.page.getByText(/Marked 4 items as reviewed/),
    ).toBeVisible();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ reviewed: true });
    expect((posted[0] as { ids: string[] }).ids).toHaveLength(4);
  });

  test("restart action opens the confirm dialog for admins", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    await openPalette(frigateApp);
    await frigateApp.page.keyboard.type("restart");
    await option(frigateApp, "Restart Frigate").click();
    const dialog = frigateApp.page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /cancel/i }).click();
    await expect(dialog).toBeHidden();
  });

  test("viewers do not see admin pages or the restart action", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({ profile: viewerProfile() });
    await frigateApp.goto("/");
    await openPalette(frigateApp);
    await expect(option(frigateApp, "Front Door").first()).toBeVisible();
    await expect(option(frigateApp, "Restart Frigate")).toHaveCount(0);
    await expect(option(frigateApp, "System logs")).toHaveCount(0);
    await expect(option(frigateApp, "Configuration Editor")).toHaveCount(0);
    await expect(option(frigateApp, "Motion tuner")).toHaveCount(0);
    await expect(option(frigateApp, "UI settings")).toHaveCount(1);
  });

  test("bottombar hint opens the palette on a phone @mobile", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile bottombar flow");
    await frigateApp.goto("/");
    const hint = frigateApp.page.getByTestId("command-palette-hint");
    await expect(hint).toHaveAttribute("aria-label", "Open command palette");
    await hint.click();
    await expect(frigateApp.page.getByTestId("command-palette")).toBeVisible();
    await frigateApp.page.keyboard.type("garage");
    await option(frigateApp, "Garage").filter({ hasText: "Live view" }).click();
    await expect(frigateApp.page).toHaveURL(/\/#garage$/);
  });
});
