import { test, expect } from "../../fixtures/frigate-test";
import {
  grantClipboardPermissions,
  readClipboard,
} from "../../helpers/clipboard";
import { noisyLogSummaryGroups } from "../../fixtures/mock-data/fork-log-summary";

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
  // On mobile the notification overlaps the filter control. Dismiss it as a
  // user would; hovering the next control can keep the toast timer paused.
  const copiedToast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Copied logs to clipboard" });
  await expect(copiedToast).toBeVisible();
  await copiedToast.getByRole("button", { name: "Close toast" }).click();
  await expect(copiedToast).toBeHidden();
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

test("repeated messages stay one quiet line when nothing repeated @medium", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  await frigateApp.goto("/logs");
  const summary = page.getByTestId("log-summary");
  await expect(summary).toContainText("Repeated messages");
  await expect(summary).toContainText("None in the last 24 hours");
  await expect(page.getByTestId("log-summary-toggle")).toBeDisabled();
  await expect(summary.getByRole("table")).toHaveCount(0);
});

test("repeated messages expand to a table and filter the log by camera @high", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  await frigateApp.installDefaults({
    logSummary: { groups: noisyLogSummaryGroups() },
  });
  await page.route(/\/api\/logs\/frigate(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("stream")) return route.fulfill({ body: "" });
    return route.fulfill({ json: { lines, totalLines: lines.length } });
  });
  await frigateApp.goto("/logs");

  const summary = page.getByTestId("log-summary");
  const toggle = page.getByTestId("log-summary-toggle");
  await expect(page.getByTestId("log-summary-line")).toHaveText(
    "31,749 repeated messages in the last 24 hours, top: Garage 31,734",
  );
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(summary.getByRole("table")).toHaveCount(0);

  // The toggle is a real button: reach it and open it from the keyboard.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const rows = page.getByTestId("log-summary-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Garage");
  await expect(rows.nth(0)).toContainText("No frames received from garage");
  await expect(rows.nth(0)).toContainText("31,000");
  await expect(rows.nth(3)).toContainText("No camera");
  await expect(summary).not.toContainText("Connection to tcp://");
  await expect(
    summary.getByRole("columnheader").filter({ hasText: "Count" }),
  ).toBeVisible();

  // Anywhere on a row with a camera restricts the log to that camera.
  await rows.nth(2).click();
  await expect(page).toHaveURL(/logs\?camera=backyard/);
  await expect(page.getByTestId("camera-log-filter")).toContainText("backyard");
  await expect(
    page.getByText("Backyard started", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Garage stream failed", { exact: true }),
  ).toHaveCount(0);
  // The summary follows the filter, and the row no longer offers it.
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByRole("button")).toHaveCount(0);

  // go2rtc has its own groups and no camera filter to apply.
  await page.getByRole("button", { name: "Show all logs" }).click();
  await page.getByLabel("Select go2rtc").click();
  await expect(page.getByTestId("log-summary-line")).toContainText(
    "5,000 repeated messages",
  );
});
