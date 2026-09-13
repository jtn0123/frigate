/**
 * Accessible names and control nesting (fork item C13).
 *
 * A dogfood pass found icon-only controls with no name (the Settings and
 * Account triggers, the logo link, the Explore detail menu), tab names built
 * from raw ids ("Select tracking_details"), and buttons nested inside
 * buttons in the Explore detail dialog and on export cards.
 */

import { test, expect } from "../../fixtures/frigate-test";

/** Count interactive controls nested inside a button under `root`. */
async function nestedButtonCount(
  page: import("@playwright/test").Page,
  rootSelector: string,
): Promise<number> {
  return page.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll(selector)).reduce(
        (n, root) =>
          n +
          root.querySelectorAll(
            'button button, button [role="button"], [role="button"] [role="button"]',
          ).length,
        0,
      ),
    rootSelector,
  );
}

test.describe("Accessible names @high", () => {
  test(
    "sidebar logo, settings and account controls are named",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      const { page } = frigateApp;
      await expect(
        page.getByRole("link", { name: "Frigate home" }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        page.getByRole("button", { name: "Settings", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Account", exact: true }),
      ).toBeVisible();
    },
  );

  test("@mobile system tabs are named after their titles", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/system#general");
    await expect(
      frigateApp.page.getByRole("radio", {
        name: "Select General",
        exact: true,
      }),
    ).toBeVisible({ timeout: 10_000 });
  });

  // Phones open tracked object details in a drawer; the dialog is desktop
  test(
    "tracked object details: named menu and edit controls, no nested buttons",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/explore");
      const { page } = frigateApp;
      await page
        .getByRole("button", { name: "Thumbnail of Person" })
        .first()
        .click({ timeout: 10_000 });
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      await expect(
        dialog.getByRole("button", { name: "More actions" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("radio", {
          name: "Select tracking details",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("radio", { name: /tracking_details/ }),
      ).toHaveCount(0);
      expect(await nestedButtonCount(page, '[role="dialog"]')).toBe(0);
    },
  );

  test(
    "tracked object details: the sub label pencil is a named button",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/explore");
      const { page } = frigateApp;
      await page
        .getByRole("button", { name: "Thumbnail of Person" })
        .first()
        .click({ timeout: 10_000 });
      await expect(
        page.getByRole("dialog").getByRole("button", {
          name: "Edit sub label",
        }),
      ).toBeVisible();
    },
  );

  test("export cards expose one named menu button", async ({ frigateApp }) => {
    await frigateApp.goto("/export");
    const card = frigateApp.page.getByRole("button", {
      name: "Front Door - Person Alert",
    });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(
      card.getByRole("button", { name: "More actions" }),
    ).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Edit name" })).toHaveCount(
      0,
    );
    // the card itself is a role=button, so its menu trigger is the only
    // control allowed inside it; nothing may nest inside that trigger
    expect(
      await frigateApp.page.evaluate(
        () =>
          document.querySelectorAll(
            '[aria-haspopup="menu"] button, [aria-haspopup="menu"] [role="button"]',
          ).length,
      ),
    ).toBe(0);
  });
});
