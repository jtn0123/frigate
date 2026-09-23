import { defineConfig, devices } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.E2E_PORT ?? 4173);
const webRoot = resolve(__dirname, "..");

// fork: one JSON report per Playwright run, in a directory of its own so
// neither the html reporter nor the next run's output cleanup removes it.
const jsonReport = resolve(
  webRoot,
  process.env.E2E_JSON_REPORT ?? "e2e-report/results.json",
);

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// The CSP specs need `vite preview` to serve the policy (E2E_CSP=1); without it
// they are not collected at all, instead of running and skipping.
const CSP_TAG = /@csp/;
const skipCsp = process.env.E2E_CSP ? [] : [CSP_TAG];
const TABLET_TAG = /@tablet-only/;

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
  // fork: the retry above turns a flaky test green, so CI reads this report
  // back and annotates, or on `next` fails, when it holds a flaky test
  // (D49, scripts/fork/e2e-flaky-report.mjs). Naming the file also keeps the
  // whole report out of the job log, where the json reporter dumped it.
  reporter: process.env.CI
    ? [["json", { outputFile: jsonReport }], ["html"]]
    : [["html"]],
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
      grepInvert: [/@mobile-only/, TABLET_TAG, ...skipCsp],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
        userAgent: DESKTOP_UA,
      },
    },
    {
      name: "mobile",
      grepInvert: [/@desktop-only/, TABLET_TAG, ...skipCsp],
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
    {
      name: "tablet",
      grep: TABLET_TAG,
      grepInvert: skipCsp,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 820, height: 1180 },
        userAgent: DESKTOP_UA,
        hasTouch: true,
      },
    },
  ],
});
