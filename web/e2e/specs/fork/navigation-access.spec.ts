import { expect, test } from "../../fixtures/frigate-test";
import { viewerProfile } from "../../fixtures/mock-data/profile";

test("shared health links respect viewer permissions @high @mobile", async ({
  frigateApp,
}) => {
  await frigateApp.installDefaults({ profile: viewerProfile() });
  await frigateApp.goto("/system?camera=front_door#health");
  await expect(
    frigateApp.page.getByRole("heading", { name: /access denied/i }),
  ).toBeVisible();
  await expect(
    frigateApp.page.getByRole("button", { name: "Copy link to this view" }),
  ).toHaveCount(0);
});

test.describe("expired shared link @high @mobile", () => {
  test.use({
    expectedErrors: [/401.*\/api\/profile|Failed to load resource.*401/],
  });
  test("expired login redirects once to the supplied login page", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let logins = 0;
    await page.route("**/api/profile", (route) =>
      route.fulfill({
        status: 401,
        headers: { location: "/login" },
        json: { message: "Session expired" },
      }),
    );
    await page.route("**/login", (route) => {
      logins++;
      return route.fulfill({
        contentType: "text/html",
        body: "<h1>Sign in</h1>",
      });
    });
    await page.goto("/system?model=audio%3Amedium&range=15#models");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect(logins).toBe(1);
  });
});

// Match the basename injected by the production ingress proxy. Asset rewriting
// is verified separately against the production build, not by this mock.
test("ingress basename survives shared links, tab changes, and reload @high @mobile", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  await page.addInitScript(() => {
    (window as Window & { baseUrl?: string }).baseUrl = "/nvr/";
  });
  await page.route("**/nvr/locales/**", async (route) => {
    const response = await route.fetch({
      url: route.request().url().replace("/nvr/locales/", "/locales/"),
    });
    await route.fulfill({ response });
  });
  await frigateApp.goto("/nvr/system?camera=front_door#health");
  await expect(
    page.getByRole("button", { name: "Copy link to this view" }),
  ).toBeVisible();
  await page.getByLabel("Select general", { exact: true }).click();
  await expect(page).toHaveURL(/\/nvr\/system\?camera=front_door#general$/);
  await page.reload();
  await expect(
    page.getByLabel("Select general", { exact: true }),
  ).toHaveAttribute("data-state", "on");
  await page.goBack();
  await expect(page).toHaveURL(/\/nvr\/system\?camera=front_door#health$/);
});
