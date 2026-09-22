import { test, expect } from "../../fixtures/frigate-test";
import {
  grantClipboardPermissions,
  readClipboard,
} from "../../helpers/clipboard";

const lines = [
  "[2026-04-06 10:00:00] ffmpeg.garage.detect ERROR: Garage stream failed",
  "[2026-04-06 10:00:01] ffmpeg.garage_2.detect ERROR: Other garage failed",
  "[2026-04-06 10:00:02] ffmpeg.backyard.detect INFO: Backyard started",
];

test("camera log link filters initial history, copy, and can be cleared @high @mobile", async ({
  frigateApp,
  context,
}) => {
  const { page } = frigateApp;
  await grantClipboardPermissions(context);
  const starts: string[] = [];
  await page.route(/\/api\/logs\/frigate(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("stream")) return route.fulfill({ body: "" });
    starts.push(url.searchParams.get("start") ?? "");
    return route.fulfill({ json: { lines, totalLines: lines.length } });
  });
  await frigateApp.goto("/system#health");
  await page.getByRole("button", { name: "Open Garage", exact: true }).click();
  await page
    .getByTestId("camera-health-drawer")
    .getByRole("link", { name: "View logs", exact: true })
    .last()
    .click();
  await expect(page).toHaveURL(/logs\?camera=garage/);
  await expect(
    page.getByText("Garage stream failed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Other garage failed", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("camera-log-filter")).toContainText("garage");
  expect(starts[0]).toBe("0");
  await page.getByLabel("Copy to Clipboard").click();
  await expect.poll(() => readClipboard(page)).toBe(lines[0]);
  await page.getByRole("button", { name: "Show all logs" }).click();
  await expect(
    page.getByText("Other garage failed", { exact: true }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/camera=/);
  await page.goBack();
  await expect(page.getByTestId("camera-log-filter")).toBeVisible();
  await expect(
    page.getByText("Other garage failed", { exact: true }),
  ).toHaveCount(0);
});

test("camera filter also restricts streamed lines @high", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  await page.route(/\/api\/logs\/frigate(\?|$)/, (route) =>
    route.fulfill({ json: { lines: [lines[0]], totalLines: 1 } }),
  );
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("api/logs/frigate") && url.includes("stream=true")) {
        return new Response(
          new ReadableStream({
            async start(controller) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              controller.enqueue(
                new TextEncoder().encode(
                  "[2026-04-06 10:01:00] ffmpeg.garage.detect INFO: Garage recovered\n[2026-04-06 10:01:01] ffmpeg.backyard.detect INFO: Backyard recovered\n",
                ),
              );
              controller.close();
            },
          }),
        );
      }
      return original.call(window, input, init);
    };
  });
  await frigateApp.goto("/logs?camera=garage");
  await expect(
    page.getByText("Garage recovered", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Backyard recovered", { exact: true }),
  ).toHaveCount(0);
});
