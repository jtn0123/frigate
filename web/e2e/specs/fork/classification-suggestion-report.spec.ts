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
  test("lays the report out as tables with Explore links", async ({
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
});
