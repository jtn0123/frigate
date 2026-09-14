/**
 * Fork: Android phone behaviour (D22, UI53-UI58, UI18).
 *
 * The mobile project runs as a Galaxy S24 Ultra in Chrome (412 x 915,
 * Android user agent). These tests cover what differs on an Android phone:
 * the system back button, the shell in landscape, fullscreen controls,
 * phone reach for pages and tracked objects, page zoom, the install
 * manifest and the phone config editor.
 */

import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";

async function openReviewFilters(frigateApp: FrigateApp) {
  // Start on Live so there is a page to go back to
  await frigateApp.goto("/");
  await frigateApp.goto("/review");
  await frigateApp.page
    .getByRole("button", { name: "Filters" })
    .first()
    .click();
  const drawer = frigateApp.page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  return drawer;
}

// A 16:9 frame scaled to the requested height, the way Frigate serves
// latest.webp: the width is rounded, so 278 px and 279 px frames differ
// slightly in aspect, which is what used to feed the resize loop
function frameSvg(height: number): string {
  const width = Math.round((height * 16) / 9);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#5a5a5a"/></svg>`;
}

async function openRecording(frigateApp: FrigateApp) {
  const { page } = frigateApp;
  await frigateApp.goto("/review");
  const cards = page.locator('.review-item [role="button"]');
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  await cards.first().focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveTitle(/Recordings/);
}

async function isOverlayEntry(frigateApp: FrigateApp) {
  return frigateApp.page.evaluate(
    () =>
      (window.history.state as { overlayOpen?: boolean } | null)
        ?.overlayOpen === true,
  );
}

test.describe("Android phone @high @mobile", () => {
  test(
    "runs as Android Chrome rather than iOS",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      const ua = await frigateApp.page.evaluate(() => navigator.userAgent);
      expect(ua).toContain("Android");
      expect(ua).not.toContain("iPhone");
    },
  );

  test(
    "back closes the filter drawer and stays on Review",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const drawer = await openReviewFilters(frigateApp);

      await frigateApp.page.goBack();
      await expect(drawer).toBeHidden();
      await expect(frigateApp.page).toHaveURL(/\/review$/);

      // The next back press leaves Review as usual
      await frigateApp.page.goBack();
      await expect(frigateApp.page).toHaveURL(/\/$/);
    },
  );

  test(
    "closing the drawer itself leaves no extra back step",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const drawer = await openReviewFilters(frigateApp);
      await expect.poll(() => isOverlayEntry(frigateApp)).toBe(true);

      await frigateApp.page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect.poll(() => isOverlayEntry(frigateApp)).toBe(false);

      await frigateApp.page.goBack();
      await expect(frigateApp.page).toHaveURL(/\/$/);
    },
  );

  test(
    "portrait recording shows Timeline / Events / Detail tabs",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openRecording(frigateApp);

      const tabs = page.getByTestId("phone-timeline-tabs");
      await expect(tabs).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Select timeline" }),
      ).toBeHidden();

      const detail = tabs.getByRole("radio", { name: "Detail" });
      await detail.click();
      await expect(detail).toHaveAttribute("aria-checked", "true");
      await expect(page).toHaveTitle(/Recordings/);
    },
  );

  test(
    "picking Detail from the landscape timeline drawer stays in the recording",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await page.setViewportSize({ width: 915, height: 412 });
      await openRecording(frigateApp);
      await expect(page.getByTestId("phone-timeline-tabs")).toBeHidden();

      // The recording view keeps its state in history, not the URL, so the
      // drawer closing must not step back past the timeline-mode change
      await page.getByRole("button", { name: "Select timeline" }).click();
      await page.getByRole("button", { name: "Detail", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(page).toHaveTitle(/Recordings/);
    },
  );

  test(
    "one tap shows detection boxes, with overlay chips under the frame",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/#front_door");
      await page.getByRole("button", { name: "Show detection boxes" }).click();

      // Boxes start on; the chips toggle overlays without hiding the frame
      const chips = page.getByTestId("phone-debug-chips");
      await expect(chips).toBeVisible();
      await expect(
        chips.getByRole("switch", { name: "Bounding Boxes" }),
      ).toHaveAttribute("aria-checked", "true");
      const zones = chips.getByRole("switch", { name: "Zones" });
      await zones.click();
      await expect(zones).toHaveAttribute("aria-checked", "true");

      // The full panel opens as a sheet and reflects the chips
      const sheet = page.getByTestId("phone-debug-sheet");
      await expect(sheet).not.toBeInViewport();
      await chips.getByRole("button", { name: "All options" }).click();
      await expect(sheet).toBeInViewport();
      await expect(page.locator("#zones")).toBeChecked();

      // Android back closes the sheet and stays on the camera
      await page.goBack();
      await expect(sheet).not.toBeInViewport();
      await expect(page).toHaveURL(/#front_door$/);

      await page.getByRole("button", { name: "Hide detection boxes" }).click();
      await expect(chips).toBeHidden();
    },
  );

  test(
    "landscape debug view keeps the frame full height with an Overlays pill",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await page.setViewportSize({ width: 915, height: 412 });
      await frigateApp.goto("/#front_door");
      await page.getByRole("button", { name: "Show detection boxes" }).click();

      await expect(page.getByTestId("phone-debug-chips")).toBeHidden();
      const pill = page.getByTestId("phone-debug-overlays");
      await expect(pill).toBeVisible();
      await expect(pill).toContainText("1");
      await pill.click();
      await expect(page.getByTestId("phone-debug-sheet")).toBeInViewport();
    },
  );

  test(
    "debug view frame settles instead of re-requesting in a loop",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      // Frames scaled to the requested height, like Frigate's, used to make
      // the frame box and the requested height flip by a pixel on every load
      const heights: string[] = [];
      await page.route("**/api/*/latest.{jpg,webp}**", (route) => {
        const height =
          new URL(route.request().url()).searchParams.get("height") ?? "360";
        heights.push(height);
        return route.fulfill({
          contentType: "image/svg+xml",
          body: frameSvg(Number(height)),
        });
      });
      await frigateApp.goto("/#front_door");
      await page.getByRole("button", { name: "Show detection boxes" }).click();
      await expect(page.getByTestId("phone-debug-chips")).toBeVisible();

      await expect
        .poll(() => heights.length, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(15);
      expect(new Set(heights.slice(-10)).size).toBe(1);
    },
  );

  test(
    "motion tuner frame settles instead of re-requesting in a loop",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const heights: string[] = [];
      await page.route("**/api/*/latest.{jpg,webp}**", (route) => {
        const height =
          new URL(route.request().url()).searchParams.get("height") ?? "360";
        heights.push(height);
        return route.fulfill({
          contentType: "image/svg+xml",
          body: frameSvg(Number(height)),
        });
      });
      await frigateApp.goto("/settings?page=motionTuner");

      await expect
        .poll(() => heights.length, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(15);
      expect(new Set(heights.slice(-10)).size).toBe(1);
    },
  );

  test(
    "landscape keeps the 48px bottom bar",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.page.setViewportSize({ width: 915, height: 412 });
      await frigateApp.goto("/");
      const box = await frigateApp.page.locator("#pageRoot").boundingBox();
      expect(box).not.toBeNull();
      expect(412 - (box!.y + box!.height)).toBe(48);
    },
  );

  test(
    "camera settings stay reachable in fullscreen",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/#front_door");
      await page.locator('[aria-label="Fullscreen"]').first().click();
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement !== null))
        .toBe(true);

      const settings = page.locator('[aria-label$=" Settings"]').first();
      await expect(settings).toBeVisible();
      await settings.click();

      // The drawer must render inside the fullscreen element to be painted
      await expect
        .poll(() =>
          page.evaluate(() => {
            const drawer = document.querySelector('[role="dialog"]');
            return (
              drawer !== null &&
              document.fullscreenElement?.contains(drawer) === true
            );
          }),
        )
        .toBe(true);
    },
  );

  test(
    "Picture in Picture is offered on Android",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      // PiP needs a restreamed (MSE/WebRTC) camera; jsmpeg has no video element
      await frigateApp.installDefaults({
        config: { go2rtc: { streams: { front_door: "rtsp://camera/main" } } },
      });
      // A restreamed camera fetches its go2rtc stream info; answer with the
      // real shape (the default mock's `{}` has no producers list)
      await frigateApp.page.route(
        "**/api/go2rtc/streams/front_door**",
        (route) => route.fulfill({ json: { producers: [], consumers: [] } }),
      );
      // This checks the PiP control, not decoded playback. Negotiate the
      // mocked stream rather than leaking a socket to the preview server.
      await frigateApp.page.routeWebSocket(
        "**/live/mse/api/ws?src=front_door",
        (socket) => {
          socket.onMessage(() => {
            socket.send(
              JSON.stringify({
                type: "mse",
                value: 'video/mp4; codecs="avc1.640029"',
              }),
            );
          });
        },
      );
      await frigateApp.goto("/#front_door");
      await expect(
        frigateApp.page.locator('[aria-label="Picture in Picture"]').first(),
      ).toBeVisible();
    },
  );

  test(
    "fullscreen controls share one rail of equal buttons",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await page.setViewportSize({ width: 915, height: 412 });
      await frigateApp.goto("/#front_door");
      // The camera view's own toggle, not the Live dashboard's header button
      await page.locator('[role="button"][aria-label="Fullscreen"]').click();
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement !== null))
        .toBe(true);

      // The app switches to the rail a render after the browser enters
      // fullscreen, so measure until the layout has settled
      await expect(async () => {
        const sizes = await page.evaluate(() => {
          const root = document.fullscreenElement!;
          const controls = [
            ...root.querySelectorAll<HTMLElement>(
              '[role="button"][aria-label], button[aria-label]',
            ),
          ].filter((el) => el.offsetParent !== null);
          return controls.map((el) => {
            const box = el.getBoundingClientRect();
            return `${Math.round(box.width)}x${Math.round(box.height)}`;
          });
        });
        expect(sizes.length).toBeGreaterThanOrEqual(3);
        expect(new Set(sizes)).toEqual(new Set(["40x40"]));
      }).toPass({ timeout: 5_000 });
    },
  );

  test(
    "live grid fullscreen sits in the header",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      const button = frigateApp.page.getByRole("button", {
        name: "Fullscreen",
      });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(36);
      // Same row as the grid/list layout toggles, not floating over tiles
      const layout = await frigateApp.page
        .getByRole("button", { name: "Use mobile list layout" })
        .boundingBox();
      expect(Math.round(box!.y)).toBe(Math.round(layout!.y));
    },
  );

  test(
    "camera groups with the default icon still show one",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      const group = frigateApp.page
        .getByRole("button", { name: "Camera Groups" })
        .first();
      await expect(group.locator("svg")).toBeVisible();
    },
  );

  test(
    "Explore detail steps to the next tracked object",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/explore?labels=person");
      const first = page.locator("[data-start]").first();
      await expect(first).toBeVisible({ timeout: 10_000 });
      await first.click();

      // The title stays on one line beside the back and previous/next buttons
      const title = page.getByRole("heading", {
        name: "Tracked Object Details",
      });
      await expect(title).toBeVisible();
      expect((await title.boundingBox())!.height).toBeLessThan(36);

      const nav = page.getByTestId("phone-detail-nav");
      await expect(nav).toBeVisible();
      await expect(
        nav.getByRole("button", { name: "Previous tracked object" }),
      ).toBeVisible();
      await nav.getByRole("button", { name: "Next tracked object" }).click();
      await expect(nav).toBeVisible();
    },
  );

  test(
    "command palette reaches Classification on a phone",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/");
      await page.getByTestId("command-palette-hint").click();
      await expect(page.getByTestId("command-palette")).toBeVisible();
      await page.keyboard.type("Classif");
      await page.getByRole("option", { name: /Classification/ }).click();
      await expect(page).toHaveURL(/\/classification$/);
    },
  );

  test(
    "config editor wraps lines without a minimap",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/config");
      await expect(page.locator(".monaco-editor").first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator(".monaco-editor .minimap")).toBeHidden();
      await expect(page.locator(".monaco-editor .folding")).toHaveCount(0);
    },
  );

  test(
    "pinch zoom is allowed on Android",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      const viewport = await frigateApp.page
        .locator('meta[name="viewport"]')
        .getAttribute("content");
      expect(viewport).not.toContain("user-scalable=no");
      expect(viewport).not.toContain("maximum-scale");
      expect(viewport).toContain("viewport-fit=cover");
    },
  );

  test(
    "install manifest has a full-size maskable icon",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/");
      const href = await page
        .locator('link[rel="manifest"]')
        .getAttribute("href");
      expect(href).toBeTruthy();
      const manifest = await (await page.request.get(href!)).json();

      expect(manifest.id).toBe("./");
      expect(manifest.description).toBeTruthy();
      expect(manifest.icons).toContainEqual(
        expect.objectContaining({ purpose: "maskable", sizes: "512x512" }),
      );
      expect(manifest.icons).toContainEqual(
        expect.objectContaining({ purpose: "monochrome", sizes: "96x96" }),
      );

      const icon = await page.request.get("/images/maskable-icon-512x512.png");
      expect(icon.status()).toBe(200);
    },
  );

  test(
    "back closes an info popover and stays on the page",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/explore?labels=person");
      const first = page.locator("[data-start]").first();
      await expect(first).toBeVisible({ timeout: 10_000 });
      await first.click();

      // The ⓘ beside Top Score in the tracked object's details
      await page
        .locator('[aria-haspopup="dialog"]', { hasText: "Info" })
        .first()
        .click();
      const popover = page.locator("[data-radix-popper-content-wrapper]");
      await expect(popover).toBeVisible();

      await page.goBack();
      await expect(popover).toBeHidden();
      await expect(
        page.getByRole("heading", { name: "Tracked Object Details" }),
      ).toBeVisible();
    },
  );

  test(
    "the system warnings button has a name",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      // The default mocks report the model server as not connected
      await frigateApp.goto("/");
      await expect(
        frigateApp.page.getByRole("button", { name: "System warnings" }),
      ).toBeVisible();
    },
  );

  test(
    "the settings override badge opens from the keyboard",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      // The mocked front_door camera overrides the global FFmpeg settings
      await frigateApp.goto("/settings?page=cameraFfmpeg");
      const badge = page
        .getByRole("button", {
          name: "This camera overrides global configuration settings in this section",
        })
        .locator("visible=true");
      await expect(badge).toHaveAttribute("aria-expanded", "false");

      await badge.focus();
      await page.keyboard.press("Enter");
      await expect(badge).toHaveAttribute("aria-expanded", "true");
      await expect(
        page.locator("[data-radix-popper-content-wrapper]"),
      ).toBeVisible();
    },
  );
});
