import { expect, test } from "../../fixtures/frigate-test";

const exportsFixture = [
  {
    id: "rename-test",
    name: "Original export",
    camera: "front_door",
    date: 1775490731,
    video_path: "/exports/test.mp4",
    thumb_path: "",
    in_progress: false,
    export_case_id: null,
  },
];

test.describe("export action recovery @high", () => {
  test.use({
    expectedErrors: [
      /500.*\/api\/(?:export\/rename-test\/rename|exports\/delete|cases(?:\?|$))/,
    ],
  });
  test("failed rename retains text, serializes retry and confirms success @mobile", async ({
    frigateApp,
  }, testInfo) => {
    const { page } = frigateApp;
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let name = "Original export";
    await frigateApp.installDefaults({ exports: exportsFixture });
    await page.route("**/api/exports", (route) =>
      route.fulfill({ json: [{ ...exportsFixture[0], name }] }),
    );
    await page.route("**/api/export/rename-test/rename", async (route) => {
      attempts++;
      if (attempts === 1) {
        await route.fulfill({ status: 500, json: { success: false } });
        return;
      }
      await gate;
      name = "Renamed export";
      await route.fulfill({ json: { success: true } });
    });
    await frigateApp.goto("/export");
    await page
      .getByRole("button", { name: /more actions/i })
      .first()
      .click();
    await page.getByRole("menuitem", { name: /edit name/i }).click();
    const dialog = page.getByRole("dialog");
    const input = dialog.getByRole("textbox");
    await input.fill("Renamed export");
    const save = dialog.getByRole("button", { name: /save export/i });
    await save.click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Your input is still here",
    );
    await expect(input).toHaveValue("Renamed export");
    await page.screenshot({ path: testInfo.outputPath("rename-recovery.png") });
    await save.click();
    await expect(save).toBeDisabled();
    await expect(save).toHaveText("Saving…");
    await expect(input).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    expect(attempts).toBe(2);
    await page.screenshot({ path: testInfo.outputPath("rename-pending.png") });
    release();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByText("Renamed export", { exact: true }),
    ).toBeVisible();
  });

  test("failed case metadata has a local retry and navigation stays usable @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let failed = true;
    await page.route("**/api/cases", (route) =>
      route.fulfill({
        status: failed ? 500 : 200,
        json: failed ? { message: "Unavailable" } : [],
      }),
    );
    await frigateApp.goto("/export");
    await expect(page.getByTestId("fork-error-state")).toBeVisible();
    failed = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByTestId("fork-error-state")).not.toBeVisible();
    await page
      .getByRole("link", { name: "Review", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/review/);
  });
});

test("metadata preloading is shared with the Exports page @high @mobile", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  let casesRequests = 0;
  await page.route("**/api/cases", (route) => {
    casesRequests++;
    return route.fulfill({ json: [] });
  });
  await frigateApp.goto("/system");
  const link = page.getByRole("link", { name: "Export", exact: true }).first();
  await link.focus();
  await expect.poll(() => casesRequests).toBe(1);
  await link.click();
  await expect(page.getByRole("button", { name: /new case/i })).toBeVisible();
  expect(casesRequests).toBe(1);
  await page.goBack();
  await expect(page).toHaveURL(/\/system/);
});

test("Explore returns from a detail and another page to the same filtered list position @high @mobile", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  await frigateApp.installDefaults({
    events: Array.from({ length: 45 }, (_, index) => ({
      id: `history-person-${index}`,
      label: "person",
      camera: "front_door",
      start_time: Date.now() / 1000 - index * 60,
      end_time: Date.now() / 1000 - index * 60 + 10,
      has_clip: false,
      has_snapshot: true,
      false_positive: false,
      zones: [],
      data: {
        type: "object",
        top_score: 0.9,
        score: 0.9,
        box: [0.1, 0.1, 0.3, 0.5],
        region: [0, 0, 1, 1],
      },
    })),
  });
  await frigateApp.goto("/explore?labels=person");
  const list = page
    .locator("div.overflow-y-auto")
    .filter({ has: page.locator("[data-start]") })
    .first();
  await expect(page.locator("[data-start]").first()).toBeVisible();
  await list.evaluate((element) => {
    element.scrollTop = 500;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBe(500);
  await page.getByRole("link", { name: "Export", exact: true }).first().click();
  await expect(page).toHaveURL(/\/export$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/explore\?labels=person$/);
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBe(500);
  const card = page.locator("[data-start]").nth(8);
  await card.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (history.state as { usr?: { exploreSelectedId?: string } }).usr
            ?.exploreSelectedId,
        ),
      ),
    )
    .toBe(true);
  await page.goBack();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (history.state as { usr?: { exploreSelectedId?: string } }).usr
            ?.exploreSelectedId ?? null,
      ),
    )
    .toBeNull();
  await expect(page).toHaveURL(/\/explore\?labels=person$/);
  await page.goForward();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (history.state as { usr?: { exploreSelectedId?: string } }).usr
            ?.exploreSelectedId,
        ),
      ),
    )
    .toBe(true);
});

test.describe("abandoned page reads @high", () => {
  test.use({
    expectedErrors: [/failed: net::ERR_ABORTED.*\/api\/exports(?:\?|$)/],
  });
  test("leaving exports cancels its slow metadata read @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    let aborted = false;
    page.on("requestfailed", (request) => {
      if (
        new URL(request.url()).pathname.endsWith("/api/exports") &&
        request.failure()?.errorText === "net::ERR_ABORTED"
      )
        aborted = true;
    });
    await page.route("**/api/exports", async (route) => {
      requests++;
      await gate;
      await route.fulfill({ json: [] });
    });
    await frigateApp.goto("/export");
    await expect.poll(() => requests).toBe(1);
    await page
      .getByRole("link", { name: "Review", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/review$/);
    await expect.poll(() => aborted).toBe(true);
    release();
    await expect(page.getByTestId("fork-error-state")).not.toBeVisible();
  });
});

test("Review retains a camera filter after leaving the page and pressing Back @high @mobile", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  await frigateApp.goto("/review?cameras=front_door");
  const savedCameras = () =>
    page.evaluate(
      () =>
        (history.state as { usr?: { reviewFilter?: { cameras?: string[] } } })
          .usr?.reviewFilter?.cameras,
    );
  await expect.poll(savedCameras).toEqual(["front_door"]);
  await expect(page).toHaveURL(/\/review$/);
  await page.getByRole("link", { name: "Export", exact: true }).first().click();
  await expect(page).toHaveURL(/\/export$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/review$/);
  await expect.poll(savedCameras).toEqual(["front_door"]);
});

test.describe("export deletion rollback @high", () => {
  test.use({ expectedErrors: [/500.*\/api\/exports\/delete/] });
  test("a failed delete restores the card and can be retried @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let attempts = 0;
    let deleted = false;
    await frigateApp.installDefaults({ exports: exportsFixture });
    await page.route("**/api/exports", (route) =>
      route.fulfill({ json: deleted ? [] : exportsFixture }),
    );
    await page.route("**/api/exports/delete", (route) => {
      attempts++;
      deleted = attempts > 1;
      return route.fulfill({
        status: deleted ? 200 : 500,
        json: { success: deleted },
      });
    });
    await frigateApp.goto("/export");
    await page
      .getByRole("button", { name: /more actions/i })
      .first()
      .click();
    await page.getByRole("menuitem", { name: /delete export/i }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: /delete export/i }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "The action failed. Try again.",
    );
    await expect(
      page.getByText("Original export", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: /delete export/i }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByText("Original export", { exact: true }),
    ).not.toBeVisible();
    expect(attempts).toBe(2);
  });
});
