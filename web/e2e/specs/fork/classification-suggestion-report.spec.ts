/**
 * Fork (I47): the suggestion report page of one custom model.
 *
 * /classification/suggestions/{model} reads the same report endpoint as the
 * status line and lays it out as tables, with the latest disagreements
 * between the trained model and the descriptions linked to Explore.
 */

import { test, expect } from "../../fixtures/frigate-test";

const MODEL = "vehicle_type";
const REPORT = {
  model: MODEL,
  total: 20,
  accepted: 17,
  rate: 0.85,
  auto_filed: 5,
  sources: { jev: { total: 15, accepted: 13, rate: 13 / 15 } },
  classes: {
    van: {
      total: 10,
      accepted: 8,
      rate: 0.8,
      corrected_to: { suv: 2 },
      auto_filed: 5,
    },
  },
  cameras: { backyard: { total: 20, accepted: 17, rate: 0.85 } },
  first_time: 1,
  last_time: 2,
  model_check: {
    total: 40,
    accepted: 36,
    rate: 0.9,
    classes: {
      suv: { total: 40, accepted: 36, rate: 0.9, corrected_to: { sedan: 4 } },
    },
    recent_disagreements: [
      {
        time: 1780673409,
        event_id: "1780673409.365581-abc123",
        camera: "backyard",
        model_said: "suv",
        draft: "sedan",
      },
    ],
  },
};

test.describe("Suggestion report page (fork I47)", () => {
  test("lays the report out as tables with Explore links @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      config: {
        classification: {
          custom: {
            [MODEL]: {
              name: MODEL,
              threshold: 0.8,
              object_config: {
                objects: ["car"],
                classification_type: "attribute",
              },
            },
          },
        },
      },
    });
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions/report`),
      (route) => route.fulfill({ json: REPORT }),
    );

    await frigateApp.goto(`/classification/suggestions/${MODEL}`);
    const report = page.getByTestId("suggestion-report");
    await expect(report).toContainText("Suggestions report: vehicle_type");
    await expect(report).toContainText("85%");
    await expect(page.getByTestId("report-classes")).toContainText("suv 2");
    await expect(page.getByTestId("report-model-check")).toContainText(
      "sedan 4",
    );
    const disagreements = page.getByTestId("report-disagreements");
    await expect(disagreements).toContainText(
      "model said suv, description said sedan",
    );
    await expect(
      disagreements.getByRole("link", { name: "Open in Explore" }),
    ).toHaveAttribute("href", "/explore?event_id=1780673409.365581-abc123");
    await report.getByRole("link", { name: "Back to classification" }).click();
    await expect(page).toHaveURL(/\/classification$/);
  });

  test("shows class balance and lets a spot check remove an auto-filed group", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const spotChecks: unknown[] = [];
    let recent = [
      {
        time: 1780673409,
        event_id: "1780673409.365581-abc123",
        camera: "backyard",
        category: "van",
        source: "jev",
        score: 0.97,
        files: ["van-1.png", "van-2.png"],
      },
    ];
    await frigateApp.installDefaults({
      config: {
        classification: {
          custom: {
            [MODEL]: {
              name: MODEL,
              threshold: 0.8,
              object_config: {
                objects: ["car"],
                classification_type: "attribute",
              },
            },
          },
        },
      },
    });
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions/report`),
      (route) =>
        route.fulfill({
          json: {
            ...REPORT,
            dataset: {
              classes: { van: 40, suv: 10, none: 0 },
              empty: ["none"],
              largest: "van",
              smallest: "suv",
              ratio: 4,
              lopsided: true,
            },
            training: {
              has_trained: true,
              last_training_date: "2026-09-20T10:00:00",
              current_images: 50,
              new_images: 12,
            },
            recent_auto_filed: recent,
          },
        }),
    );
    await page.route(
      new RegExp(`/api/classification/${MODEL}/suggestions/spot-check`),
      (route) => {
        spotChecks.push(route.request().postDataJSON());
        recent = [];
        return route.fulfill({
          json: { success: true, message: "ok", removed: ["van-1.png"] },
        });
      },
    );
    await page.route("**/clips/**", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );

    await frigateApp.goto(`/classification/suggestions/${MODEL}`);
    const report = page.getByTestId("suggestion-report");
    await expect(report).toContainText("New since training");
    await expect(report).toContainText("12");
    const balance = page.getByTestId("report-balance");
    await expect(balance).toContainText("van has 4x the images of suv");
    await expect(balance).toContainText("No images yet: none");

    const group = page.getByTestId("spot-check-group");
    await expect(group).toHaveCount(1);
    await expect(group).toContainText("2 images");
    await group.getByRole("button", { name: "Remove" }).click();
    await expect.poll(() => spotChecks.length).toBe(1);
    expect(spotChecks[0]).toEqual({
      event_id: "1780673409.365581-abc123",
      category: "van",
      files: ["van-1.png", "van-2.png"],
      keep: false,
    });
    await expect(page.getByText(/removed 2 images from van/i)).toBeVisible();
    await expect(page.getByTestId("spot-check-group")).toHaveCount(0);
  });
});
