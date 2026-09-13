/** Collect real Chromium execution ranges for the built application. */
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

export async function startBrowserCoverage(page: Page) {
  if (process.env.E2E_COVERAGE === "1")
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
}

export async function saveBrowserCoverage(page: Page, info: TestInfo) {
  if (process.env.E2E_COVERAGE !== "1") return;
  const entries = await page.coverage.stopJSCoverage();
  const result = entries.flatMap((entry) => {
    const pathname = new URL(entry.url, "http://coverage.invalid").pathname;
    if (!pathname.startsWith("/assets/") || !pathname.endsWith(".js"))
      return [];
    return [{ scriptId: pathname, url: pathname, functions: entry.functions }];
  });
  const id = createHash("sha256")
    .update(info.testId + info.project.name + info.retry)
    .digest("hex");
  const directory = resolve("coverage-browser");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${id}.json`), JSON.stringify({ result }));
}
