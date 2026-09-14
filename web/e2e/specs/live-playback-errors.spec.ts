import { test, expect } from "../fixtures/frigate-test";

test("live video stops loading and offers Retry when no frame arrives @mobile", async ({
  frigateApp,
}, testInfo) => {
  const page = frigateApp.page;
  const requests: string[] = [];
  await page.route("**/api/go2rtc/streams/*/diagnostics", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      json: { id: "playback-test", status: "decode_error", codecs: ["H265"] },
    });
  });
  await frigateApp.goto("/#front_door");
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "Live video is unavailable" });
  await expect(failure).toBeVisible({ timeout: 15_000 });
  await expect(failure).toContainText("The server encountered decoding errors");
  await expect(failure).toContainText("playback-test");
  expect(requests).toHaveLength(1);
  await page.screenshot({
    path: testInfo.outputPath("live-playback-error.png"),
  });
  await failure.getByRole("button", { name: "Retry live video" }).click();
  await expect(failure).not.toBeVisible();
  await expect(page).toHaveURL(/#front_door/);
  await expect(failure).toBeVisible({ timeout: 15_000 });
});
