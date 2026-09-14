import { defineConfig, devices } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.E2E_PORT ?? 4173);
const webRoot = resolve(__dirname, "..");

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// The CSP specs need `vite preview` to serve the policy (E2E_CSP=1); without it
// they are not collected at all, instead of running and skipping.
const CSP_TAG = /@csp/;
const skipCsp = process.env.E2E_CSP ? [] : [CSP_TAG];

// fork: the phones this fork targets are Android flagships (Galaxy S24 Ultra,
// current Pixels) in Chrome, so the mobile project runs as one. With an
// iPhone UA every `isIOS` branch ran instead of the Android paths.
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

export default defineConfig({
  globalSetup: "./global-setup.ts",
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
      // fork: tests for one layout are tagged instead of skipped at run time
      grepInvert: [/@mobile-only/, ...skipCsp],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
        userAgent: DESKTOP_UA,
      },
    },
    {
      name: "mobile",
      grepInvert: [/@desktop-only/, ...skipCsp],
      use: {
        ...devices["Desktop Chrome"],
        // 412 x 915 CSS px at 3.5x: Pixel 9 Pro XL / Galaxy S Ultra class
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 3.5,
        userAgent: MOBILE_UA,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
