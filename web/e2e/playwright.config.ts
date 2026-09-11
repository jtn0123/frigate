import { defineConfig, devices } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.E2E_PORT ?? 4173);
const webRoot = resolve(__dirname, "..");

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export default defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 4,
  reporter: process.env.CI ? [["json"], ["html"]] : [["html"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  webServer: {
    command: `npx vite preview --port ${port}`,
    port,
    cwd: webRoot,
    reuseExistingServer: !process.env.CI,
  },

  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
        userAgent: DESKTOP_UA,
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        userAgent: MOBILE_UA,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      // Tablet-sized window with a desktop user agent: exercises the
      // 768-1279 px range where the desktop shell has the least room.
      // Tests that genuinely need a wide desktop window carry the @wide
      // tag and are filtered out of this project.
      name: "tablet",
      grepInvert: /@wide/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1024, height: 768 },
        userAgent: DESKTOP_UA,
      },
    },
  ],
});
