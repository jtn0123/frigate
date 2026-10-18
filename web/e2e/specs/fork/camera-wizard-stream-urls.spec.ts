/**
 * UI154 (upstream #24570): the stream URLs Step 2 of the Add Camera Wizard
 * probes for a brand template. Upstream's camera-wizard-reolink spec covers
 * a camera above 5MP; this covers a camera detected as http-flv, a Reolink
 * without credentials, a stream that never probes, and a fixed template.
 */

import { test, expect } from "../../fixtures/frigate-test";
import type { Page } from "@playwright/test";

const FLV_PATH = "channel0_main.bcs";
const RTSP_PATH = "Preview_01_main";
const HIKVISION_PATH = "Streaming/Channels/101";

const FFPROBE_OK = [
  {
    return_code: 0,
    stderr: [],
    stdout: {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 2560,
          height: 1440,
          avg_frame_rate: "15/1",
        },
      ],
    },
  },
];

const FFPROBE_FAILED = [
  { return_code: 1, stderr: ["probe failed"], stdout: "" },
];

type Options = {
  brand: string;
  protocol?: string | null;
  probes?: boolean;
  credentials?: boolean;
};

/**
 * Mock the camera, fill Step 1 for a brand and continue to Step 2. Returns
 * the dialog and the stream paths the wizard probed, in order.
 */
async function openStep2(
  page: Page,
  { brand, protocol = null, probes = true, credentials = true }: Options,
) {
  const probed: string[] = [];

  await page.route("**/api/reolink/detect**", (route) =>
    route.fulfill({ json: { success: protocol !== null, protocol } }),
  );
  await page.route("**/api/ffprobe**", (route) => {
    const paths = new URL(route.request().url()).searchParams.get("paths");
    probed.push(paths ?? "");
    return route.fulfill({ json: probes ? FFPROBE_OK : FFPROBE_FAILED });
  });
  await page.route("**/api/ffprobe/snapshot**", (route) =>
    route.fulfill({ status: 500 }),
  );

  await page.getByRole("button", { name: /Add New Camera/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder(/front_door/i).fill("stream_url_camera");
  await dialog.getByPlaceholder("192.168.1.100").fill("192.168.1.100");
  if (credentials) {
    await dialog.getByPlaceholder("Optional").first().fill("admin");
    await dialog.getByPlaceholder("Optional").last().fill("pw");
  }
  await dialog.getByText("Manual selection").click();
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: brand }).click();
  await dialog.getByRole("button", { name: /^Continue$/i }).click();

  return { dialog, probed };
}

test.describe("Camera wizard stream URLs (UI154) @medium @mobile", () => {
  test.beforeEach(async ({ frigateApp }) => {
    // not in the default mock; unmocked it 500s and trips the error collector
    await frigateApp.page.route("**/api/config/raw_paths", (route) =>
      route.fulfill({ json: {} }),
    );
    await frigateApp.goto("/settings?page=cameraManagement");
    await expect(
      frigateApp.page.getByRole("heading", { name: /Manage Cameras/i }),
    ).toBeVisible();
  });

  test("a camera detected as http-flv probes only the http-flv stream", async ({
    frigateApp,
  }) => {
    const { dialog, probed } = await openStep2(frigateApp.page, {
      brand: "Reolink",
      protocol: "http-flv",
    });

    await expect(
      dialog.getByRole("button", { name: /^Continue$/i }),
    ).toBeEnabled({ timeout: 10_000 });
    await expect.poll(() => probed.length, { timeout: 10_000 }).toBe(1);
    expect(probed[0]).toContain(FLV_PATH);
  });

  test("a Reolink without credentials probes RTSP", async ({ frigateApp }) => {
    const { dialog, probed } = await openStep2(frigateApp.page, {
      brand: "Reolink",
      protocol: "http-flv",
      credentials: false,
    });

    await expect(
      dialog.getByRole("button", { name: /^Continue$/i }),
    ).toBeEnabled({ timeout: 10_000 });
    await expect.poll(() => probed.length, { timeout: 10_000 }).toBe(1);
    expect(probed[0]).toContain(RTSP_PATH);
  });

  test("a stream that never probes tries both and stays on Step 2", async ({
    frigateApp,
  }) => {
    const { dialog, probed } = await openStep2(frigateApp.page, {
      brand: "Reolink",
      protocol: "rtsp",
      probes: false,
    });

    await expect.poll(() => probed.length, { timeout: 10_000 }).toBe(2);
    expect(probed[0]).toContain(FLV_PATH);
    expect(probed[1]).toContain(RTSP_PATH);
    await expect(
      dialog.getByRole("button", { name: /Add Another Stream/i }),
    ).toHaveCount(0);
  });

  test("a fixed brand template probes its one URL", async ({ frigateApp }) => {
    const { dialog, probed } = await openStep2(frigateApp.page, {
      brand: "Hikvision / Uniview / Annke",
    });

    await expect(
      dialog.getByRole("button", { name: /^Continue$/i }),
    ).toBeEnabled({ timeout: 10_000 });
    await expect.poll(() => probed.length, { timeout: 10_000 }).toBe(1);
    expect(probed[0]).toContain(HIKVISION_PATH);
  });
});
