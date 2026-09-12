/**
 * D2: Camera wizard steps, validation, and the final config/set payload.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/frigate-test";

const FFPROBE_OK = [
  {
    return_code: 0,
    stdout: {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          avg_frame_rate: "15/1",
        },
      ],
    },
    stderr: [],
  },
];

const ONVIF_OK = {
  success: true,
  manufacturer: "Generic",
  model: "Test",
  firmware: "1.0",
  rtsp_candidates: [
    {
      source: "GetStreamUri",
      uri: "rtsp://192.168.1.50:554/stream1",
    },
  ],
};

async function installWizardRoutes(page: Page) {
  const saved: unknown[] = [];
  await page.route("**/api/onvif/probe**", (route) =>
    route.fulfill({ json: ONVIF_OK }),
  );
  await page.route("**/api/ffprobe/snapshot**", (route) =>
    route.fulfill({ json: { success: true } }),
  );
  await page.route("**/api/ffprobe**", (route) =>
    route.fulfill({ json: FFPROBE_OK }),
  );
  await page.route("**/api/config/set", async (route) => {
    saved.push(route.request().postDataJSON());
    await route.fulfill({ json: { success: true, require_restart: true } });
  });
  return { saved };
}

async function openWizard(page: Page) {
  await page.getByRole("button", { name: /Add New Camera/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Add Camera").first()).toBeVisible();
  return dialog;
}

test.describe("Camera wizard @high", () => {
  test("Continue stays disabled until name and host are set", async ({
    frigateApp,
  }) => {
    await installWizardRoutes(frigateApp.page);
    await frigateApp.goto("/settings?page=cameraManagement");
    await expect(
      frigateApp.page.getByRole("heading", { name: /Manage Cameras/i }),
    ).toBeVisible();
    const dialog = await openWizard(frigateApp.page);
    const cont = dialog.getByRole("button", { name: /^Continue$/i });
    await expect(cont).toBeDisabled();

    await dialog.getByLabel(/Camera Name/i).fill("front_door");
    await dialog.getByLabel(/Host\/IP Address/i).fill("192.168.1.50");
    await expect(cont).toBeEnabled();
    await cont.click();
    await expect(dialog.getByText(/already exists/i)).toBeVisible();

    await dialog.getByLabel(/Camera Name/i).fill("side_gate");
    await expect(cont).toBeEnabled();
  });

  test("probe, next, and save post the new camera config", async ({
    frigateApp,
  }) => {
    const { saved } = await installWizardRoutes(frigateApp.page);
    await frigateApp.goto("/settings?page=cameraManagement");
    const dialog = await openWizard(frigateApp.page);
    await dialog.getByLabel(/Camera Name/i).fill("side_gate");
    await dialog.getByLabel(/Host\/IP Address/i).fill("192.168.1.50");
    await dialog.getByRole("button", { name: /^Continue$/i }).click();

    await expect(dialog.getByText(/Device Information/i)).toBeVisible({
      timeout: 10_000,
    });
    await dialog.getByRole("button", { name: /^Next$/i }).click();
    await dialog.getByRole("button", { name: /^Next$/i }).click();
    await expect(
      dialog.getByRole("button", { name: /Save New Camera/i }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: /Connect All Streams/i }).click();
    await expect(
      dialog.getByRole("button", { name: /Save New Camera/i }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: /Save New Camera/i }).click();

    await expect.poll(() => saved.length).toBeGreaterThan(0);
    const add = saved.find((row) => {
      if (!row || typeof row !== "object" || !("config_data" in row)) {
        return false;
      }
      const cameras = (
        row as { config_data?: { cameras?: Record<string, unknown> } }
      ).config_data?.cameras;
      return cameras !== undefined && "side_gate" in cameras;
    });
    expect(add).toMatchObject({
      requires_restart: 1,
      update_topic: "config/cameras/side_gate/add",
      config_data: {
        cameras: {
          side_gate: {
            enabled: true,
          },
        },
      },
    });
  });

  test.describe("mobile", () => {
    // Skip on desktop: this case only checks the mobile Add Camera open path.
    test.skip(({ frigateApp }) => !frigateApp.isMobile, "Mobile open path");
    test("opens from Add New Camera @mobile", async ({ frigateApp }) => {
      await installWizardRoutes(frigateApp.page);
      await frigateApp.goto("/settings?page=cameraManagement");
      const dialog = await openWizard(frigateApp.page);
      await expect(
        dialog.getByRole("button", { name: /^Continue$/i }),
      ).toBeDisabled();
    });
  });
});
