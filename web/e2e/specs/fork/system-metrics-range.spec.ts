/**
 * Fork (D54): the System page's time range toggle.
 *
 * The General tab graphed a fixed 20 minute window held in memory. A range
 * picker now reaches into the stored history for up to 30 days, and the
 * choice is remembered.
 */

import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";

const TOGGLE = "metric-range";
const NOTE = "metric-range-note";

async function openGeneral(frigateApp: FrigateApp) {
  await frigateApp.goto("/system#general");
  await expect(frigateApp.page.getByTestId(TOGGLE)).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("System metrics time range (D54) @medium @mobile", () => {
  test("opens on the live window and says what a point is", async ({
    frigateApp,
  }) => {
    await openGeneral(frigateApp);

    await expect(frigateApp.page.getByTestId(TOGGLE)).toHaveValue("live");
    await expect(frigateApp.page.getByTestId(NOTE)).toHaveText(
      "Live samples, 15 seconds apart, since Frigate started",
    );
  });

  test("asks the backend for the range the user picked", async ({
    frigateApp,
  }) => {
    await openGeneral(frigateApp);

    const request = frigateApp.page.waitForRequest((call) =>
      call.url().includes("/api/system/metrics/history?range=24h"),
    );
    await frigateApp.page.getByTestId(TOGGLE).selectOption("24h");
    await request;

    await expect(frigateApp.page.getByTestId(NOTE)).toHaveText(
      "Each point averages 15 minutes",
    );
  });

  test("keeps every graph on a month long range", async ({ frigateApp }) => {
    await openGeneral(frigateApp);

    await frigateApp.page.getByTestId(TOGGLE).selectOption("30d");

    await expect(frigateApp.page.getByTestId(NOTE)).toHaveText(
      "Each point averages 4 hours",
    );
    await expect(
      frigateApp.page.getByText("Detector Inference Speed", { exact: true }),
    ).toBeVisible();
  });

  test("remembers the range across a reload", async ({ frigateApp }) => {
    await openGeneral(frigateApp);

    await frigateApp.page.getByTestId(TOGGLE).selectOption("6h");
    await expect(frigateApp.page.getByTestId(NOTE)).toHaveText(
      "Each point averages 5 minutes",
    );

    await frigateApp.page.reload();

    await expect(frigateApp.page.getByTestId(TOGGLE)).toHaveValue("6h", {
      timeout: 10_000,
    });
  });
});
