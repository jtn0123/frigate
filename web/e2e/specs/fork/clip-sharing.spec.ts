/**
 * Fork: expiring clip share link + QR (UI item 11).
 *
 * Explore's detail dialog exposes Share; the public /share/:token page
 * plays the clip without a login.
 */

import { test, expect } from "../../fixtures/frigate-test";

const SHARE_BODY = {
  token: "e2eShareToken123456789012345678",
  url: "/share/e2eShareToken123456789012345678",
  expires_at: Date.now() / 1000 + 3600,
  event_id: "event-person-001",
  camera: "front_door",
  label: "person",
  start_time: 1780677009,
  end_time: 1780677039,
  has_clip: true,
};

const ACTIVE_LINKS = [
  {
    token: SHARE_BODY.token,
    url: SHARE_BODY.url,
    event_id: SHARE_BODY.event_id,
    camera: SHARE_BODY.camera,
    created_by: "admin",
    created_at: Date.now() / 1000 - 5,
    expires_at: SHARE_BODY.expires_at,
  },
  {
    token: "e2eOlderToken123456789012345678",
    url: "/share/e2eOlderToken123456789012345678",
    event_id: "event-car-002",
    camera: "backyard",
    created_by: "admin",
    created_at: Date.now() / 1000 - 3600,
    expires_at: Date.now() / 1000 + 3 * 86400 + 600,
  },
];

test.describe("Clip sharing @high", () => {
  test("Explore detail can create a share link with a QR code", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await page.route("**/api/fork/share", async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ json: SHARE_BODY });
      }
      return route.fallback();
    });

    await frigateApp.goto("/explore?labels=person");
    await page.locator('img[src*="/thumbnail.webp"]').first().click();
    const share = page.getByTestId("share-clip");
    await expect(share).toBeVisible({ timeout: 10_000 });
    await share.click();
    await expect(page.getByTestId("share-clip-dialog")).toBeVisible();
    await expect(page.getByTestId("share-clip-url")).toHaveValue(
      /\/share\/e2eShareToken/,
    );
    await expect(
      page.getByTestId("share-clip-qr").locator("svg"),
    ).toBeVisible();
  });

  test("the share dialog lists active links and revokes one", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let links = [...ACTIVE_LINKS];
    const revoked: string[] = [];
    await page.route("**/api/fork/share", async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ json: SHARE_BODY });
      }
      return route.fulfill({ json: links });
    });
    await page.route("**/api/fork/share/*", async (route) => {
      if (route.request().method() !== "DELETE") {
        return route.fallback();
      }
      const token = route.request().url().split("/").pop() ?? "";
      revoked.push(token);
      links = links.filter((link) => link.token !== token);
      return route.fulfill({
        json: { success: true, message: "Share link revoked" },
      });
    });

    await frigateApp.goto("/explore?labels=person");
    await page.locator('img[src*="/thumbnail.webp"]').first().click();
    await page.getByTestId("share-clip").click();

    const dialog = page.getByTestId("share-clip-dialog");
    await expect(dialog.getByRole("img", { name: /QR code/ })).toBeVisible();
    const active = dialog.getByTestId("share-clip-active");
    await expect(
      active.getByRole("heading", { name: "Active links" }),
    ).toBeVisible();
    const rows = active.getByTestId("share-clip-active-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("(this link)");
    await expect(rows.nth(1)).toContainText("Expires in 3 days");

    await rows
      .nth(1)
      .getByRole("button", { name: /Revoke the share link for backyard/ })
      .click();
    await expect(rows).toHaveCount(1);
    expect(revoked).toEqual(["e2eOlderToken123456789012345678"]);
    // the dialog's own link is untouched
    await expect(page.getByTestId("share-clip-url")).toBeVisible();

    await rows
      .nth(0)
      .getByRole("button", { name: /Revoke/ })
      .click();
    await expect(
      dialog.getByText("This link was revoked and no longer works."),
    ).toBeVisible();
    await expect(page.getByTestId("share-clip-url")).toHaveCount(0);
    await expect(
      active.getByText("You have no active share links."),
    ).toBeVisible();
  });

  test("a malformed share token never reaches the server", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const requests: string[] = [];
    await page.route("**/api/fork/share/**", (route) => {
      requests.push(route.request().url());
      return route.fulfill({ status: 404, json: { success: false } });
    });

    await frigateApp.goto("/share/short");
    await expect(page.getByTestId("share-clip-page")).toContainText(
      "This share link was not found.",
    );
    expect(requests).toEqual([]);
  });

  test("public share page shows the clip metadata and QR @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await page.route(
      "**/api/fork/share/e2eShareToken123456789012345678",
      (route) => {
        if (route.request().method() === "GET") {
          return route.fulfill({ json: SHARE_BODY });
        }
        return route.fallback();
      },
    );
    await page.route(
      "**/api/fork/share/e2eShareToken123456789012345678/clip.mp4",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "video/mp4",
          body: "",
        }),
    );

    await frigateApp.goto("/share/e2eShareToken123456789012345678");
    const root = page.getByTestId("share-clip-page");
    await expect(root).toBeVisible({ timeout: 10_000 });
    await expect(root).toContainText(/person/i);
    await expect(root).toContainText(/front_door/i);
    await expect(
      page.getByTestId("share-clip-qr").locator("svg"),
    ).toBeVisible();
  });
});
