/**
 * Fork: notification inbox (UI item 14).
 *
 * Review alerts and detections arriving on the `reviews` WebSocket topic are
 * collected into a localStorage-backed inbox with an unread badge on a bell,
 * per-camera mute and quiet hours.
 */

import { test, expect } from "../../fixtures/frigate-test";
import type { FrigateApp } from "../../fixtures/frigate-test";

type ReviewOptions = {
  id: string;
  camera?: string;
  severity?: "alert" | "detection";
  objects?: string[];
  type?: "new" | "update" | "end";
};

function reviewMessage({
  id,
  camera = "front_door",
  severity = "alert",
  objects = ["person"],
  type = "new",
}: ReviewOptions) {
  const segment = {
    id,
    camera,
    severity,
    start_time: Date.now() / 1000 - 30,
    end_time: type === "end" ? Date.now() / 1000 : null,
    thumb_path: `/media/frigate/clips/review/thumb-${camera}-${id}.webp`,
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: [`${id}-obj`],
      objects,
      sub_labels: [],
      significant_motion_areas: [],
      zones: ["front_yard"],
    },
  };
  return { type, before: segment, after: segment };
}

/**
 * Send a review and wait until the inbox shows it. The WS mock only has a
 * socket after the app connects, and ingestion dedupes by id, so retrying
 * the send is safe.
 */
async function sendReviewAndWait(
  frigateApp: FrigateApp,
  options: ReviewOptions,
  expectedUnread: number,
) {
  await expect(async () => {
    frigateApp.ws.sendReview(reviewMessage(options));
    await expect(frigateApp.page.getByTestId("inbox-unread")).toHaveText(
      String(expectedUnread),
      { timeout: 1_000 },
    );
  }).toPass({ timeout: 10_000 });
}

async function openInbox(frigateApp: FrigateApp) {
  await frigateApp.page.getByTestId("inbox-bell").click();
  await expect(frigateApp.page.getByTestId("inbox-panel")).toBeVisible();
}

function hhmm(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

test.describe("Notification inbox @high", () => {
  test("collects a review alert with an unread badge and item details", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    await expect(frigateApp.page.getByTestId("inbox-unread")).toHaveCount(0);
    await sendReviewAndWait(frigateApp, { id: "inbox-1" }, 1);

    const bell = frigateApp.page.getByTestId("inbox-bell");
    await expect(bell).toHaveAttribute(
      "aria-label",
      "Open notification inbox, 1 unread",
    );

    await openInbox(frigateApp);
    const item = frigateApp.page.getByTestId("inbox-item");
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute("data-read", "false");
    await expect(item.getByText("Front Door")).toBeVisible();
    await expect(item.getByText("Alert", { exact: true })).toBeVisible();
    await expect(item.getByText("Person")).toBeVisible();
    await expect(item.locator("img")).toHaveAttribute(
      "src",
      /clips\/review\/thumb-front_door-inbox-1\.webp$/,
    );
  });

  test("mark all read clears the badge and dismiss removes an item", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    await sendReviewAndWait(frigateApp, { id: "inbox-a" }, 1);
    await sendReviewAndWait(
      frigateApp,
      {
        id: "inbox-b",
        camera: "garage",
        severity: "detection",
        objects: ["car"],
      },
      2,
    );
    await openInbox(frigateApp);
    await expect(frigateApp.page.getByTestId("inbox-item")).toHaveCount(2);
    await frigateApp.page
      .getByRole("button", { name: "Mark all as read" })
      .click();
    await expect(frigateApp.page.getByTestId("inbox-unread")).toHaveCount(0);
    await expect(
      frigateApp.page.getByTestId("inbox-item").first(),
    ).toHaveAttribute("data-read", "true");

    await frigateApp.page
      .getByRole("button", { name: "Dismiss" })
      .first()
      .click();
    await expect(frigateApp.page.getByTestId("inbox-item")).toHaveCount(1);

    await frigateApp.page.getByRole("button", { name: "Clear inbox" }).click();
    await expect(frigateApp.page.getByTestId("inbox-item")).toHaveCount(0);
    await expect(
      frigateApp.page.getByText(/No notifications yet/),
    ).toBeVisible();
  });

  test("opening an item marks it read and deep links to review", async ({
    frigateApp,
  }) => {
    await frigateApp.page.route("**/api/review/inbox-link", (route) =>
      route.fulfill({ json: reviewMessage({ id: "inbox-link" }).after }),
    );
    await frigateApp.goto("/");
    await sendReviewAndWait(frigateApp, { id: "inbox-link" }, 1);
    await openInbox(frigateApp);
    await frigateApp.page
      .getByTestId("inbox-item")
      .getByRole("button")
      .first()
      .click();
    await expect(frigateApp.page).toHaveURL(/\/review/);
    await expect(frigateApp.page.getByTestId("inbox-unread")).toHaveCount(0);
  });

  test("items survive a reload via localStorage", async ({ frigateApp }) => {
    await frigateApp.goto("/");
    await sendReviewAndWait(frigateApp, { id: "inbox-persist" }, 1);
    const stored = await frigateApp.page.evaluate(() =>
      JSON.parse(localStorage.getItem("frigateFork.inbox.items") ?? "[]"),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "inbox-persist", read: false });

    await frigateApp.page.reload();
    await frigateApp.page.waitForSelector("#pageRoot", { timeout: 10_000 });
    await expect(frigateApp.page.getByTestId("inbox-unread")).toHaveText("1");
    await openInbox(frigateApp);
    await expect(frigateApp.page.getByTestId("inbox-item")).toHaveCount(1);
  });

  test("muted cameras are dropped and the setting persists", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    await sendReviewAndWait(frigateApp, { id: "inbox-m1" }, 1);
    await openInbox(frigateApp);
    await frigateApp.page
      .getByRole("button", { name: "Inbox settings" })
      .click();
    await expect(frigateApp.page.getByTestId("inbox-settings")).toBeVisible();
    const mute = frigateApp.page.getByRole("switch", {
      name: "Mute Front Door",
    });
    await mute.click();
    await expect(mute).toHaveAttribute("aria-checked", "true");

    const settings = await frigateApp.page.evaluate(() =>
      JSON.parse(localStorage.getItem("frigateFork.inbox.settings") ?? "{}"),
    );
    expect(settings.mutedCameras).toEqual(["front_door"]);

    // a backyard review still lands, a front_door one does not
    await sendReviewAndWait(
      frigateApp,
      { id: "inbox-m2", camera: "backyard" },
      2,
    );
    frigateApp.ws.sendReview(reviewMessage({ id: "inbox-m3" }));
    await expect(frigateApp.page.getByTestId("inbox-item")).toHaveCount(2);
    await expect(frigateApp.page.getByTestId("inbox-unread")).toHaveText("2");
  });

  test("quiet hours store new items without an unread badge", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    await openInbox(frigateApp);
    await frigateApp.page
      .getByRole("button", { name: "Inbox settings" })
      .click();
    const quiet = frigateApp.page.getByRole("switch", { name: "Quiet hours" });
    await quiet.click();
    await expect(quiet).toHaveAttribute("aria-checked", "true");

    const start = hhmm(new Date(Date.now() - 60 * 60 * 1000));
    const end = hhmm(new Date(Date.now() + 60 * 60 * 1000));
    await frigateApp.page.getByLabel("From").fill(start);
    await frigateApp.page.getByLabel("To").fill(end);
    await expect(
      frigateApp.page.getByText(`Quiet hours ${start} to ${end}`),
    ).toBeVisible();

    await expect(async () => {
      frigateApp.ws.sendReview(reviewMessage({ id: "inbox-quiet" }));
      await expect(frigateApp.page.getByTestId("inbox-item")).toHaveCount(1, {
        timeout: 1_000,
      });
    }).toPass({ timeout: 10_000 });
    await expect(frigateApp.page.getByTestId("inbox-item")).toHaveAttribute(
      "data-read",
      "true",
    );
    await expect(frigateApp.page.getByTestId("inbox-unread")).toHaveCount(0);
  });

  test("bell in the bottombar opens the inbox drawer @mobile", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile bottombar flow");
    await frigateApp.goto("/");
    await sendReviewAndWait(
      frigateApp,
      { id: "inbox-mobile", camera: "garage", objects: ["dog"] },
      1,
    );
    await openInbox(frigateApp);
    const item = frigateApp.page.getByTestId("inbox-item");
    await expect(item).toHaveCount(1);
    await expect(item.getByText("Garage")).toBeVisible();
    await expect(item.getByText("Dog")).toBeVisible();
  });
});
