/**
 * UI147 (upstream #24637): a deep link opened while signed out returns to
 * the requested page after logging in, not to the home page. Only targets on
 * this origin are honored.
 */

import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";
import { adminProfile } from "../../fixtures/mock-data/profile";

test.describe("Login redirect @high", () => {
  // a 401 on /profile is how the app learns that a login is required
  test.use({ expectedErrors: [/401/] });

  async function requireLogin(frigateApp: FrigateApp) {
    let loggedIn = false;
    await frigateApp.page.route("**/api/profile", (route) =>
      loggedIn
        ? route.fulfill({ json: adminProfile() })
        : route.fulfill({ status: 401, body: "" }),
    );
    await frigateApp.page.route("**/api/login", (route) => {
      loggedIn = true;
      return route.fulfill({ json: {} });
    });
    await frigateApp.page.route("**/api/auth/first_time_login", (route) =>
      route.fulfill({ json: { admin_first_time_login: false } }),
    );
  }

  async function logIn(frigateApp: FrigateApp) {
    await frigateApp.page.getByLabel("Username").fill("admin");
    await frigateApp.page.getByLabel("Password").fill("password");
    await frigateApp.page.getByRole("button", { name: "Login" }).click();
  }

  test("returns to the requested url after logging in @mobile", async ({
    frigateApp,
  }) => {
    await requireLogin(frigateApp);
    await frigateApp.page.goto("/explore?labels=person");
    await expect(frigateApp.page).toHaveURL(
      `/login?redirect=${encodeURIComponent("/explore?labels=person")}`,
      { timeout: 10_000 },
    );

    await logIn(frigateApp);
    await expect(frigateApp.page).toHaveURL("/explore?labels=person", {
      timeout: 10_000,
    });
    await expect(frigateApp.page.locator("#pageRoot")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("keeps the hash of a deep link", async ({ frigateApp }) => {
    await requireLogin(frigateApp);
    await frigateApp.page.goto("/system#storage");
    await expect(frigateApp.page).toHaveURL(
      `/login?redirect=${encodeURIComponent("/system#storage")}`,
      { timeout: 10_000 },
    );

    await logIn(frigateApp);
    await expect(frigateApp.page).toHaveURL("/system#storage", {
      timeout: 10_000,
    });
  });

  test("goes home after logging in from the home page", async ({
    frigateApp,
  }) => {
    await requireLogin(frigateApp);
    await frigateApp.page.goto("/");
    await expect(frigateApp.page).toHaveURL("/login", { timeout: 10_000 });

    await logIn(frigateApp);
    await expect(frigateApp.page).toHaveURL("/", { timeout: 10_000 });
  });

  for (const target of ["https://example.com/", "//example.com/"]) {
    test(`ignores a redirect to another site (${target})`, async ({
      frigateApp,
    }) => {
      await requireLogin(frigateApp);
      await frigateApp.page.goto(
        `/login?redirect=${encodeURIComponent(target)}`,
      );

      await logIn(frigateApp);
      await expect(frigateApp.page).toHaveURL("/", { timeout: 10_000 });
    });
  }
});
