/**
 * Phone layout helpers for the Settings specs.
 *
 * On a phone Settings starts as a list of collapsible groups; tapping a
 * section slides it in as a full-screen panel with a Back button. These
 * helpers drive that flow and check the panel fits the 412px viewport.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { waitForAppReady } from "./app-ready";

type SectionPath = {
  /** Group heading in the phone menu, or null for single-item groups */
  group: string | null;
  /** Section label in the menu, also the panel title */
  section: string;
};

/** Open /settings and tap into a section the way a phone user would. */
export async function openPhoneSettingsSection(
  page: Page,
  { group, section }: SectionPath,
) {
  await page.goto("/settings");
  await waitForAppReady(page);
  await expect(
    page.getByRole("heading", { level: 2, name: "Settings" }),
  ).toBeVisible();

  if (group) {
    await page
      // The page, not the bottom bar: "System warnings" also starts with System
      .locator("#pageRoot")
      .getByRole("button", { name: new RegExp(`^${escapeRegExp(group)}`) })
      .click();
  }
  await page.getByRole("button", { name: section, exact: true }).click();

  const title = page.getByRole("heading", { level: 2, name: section });
  await expect(title).toBeInViewport();
  const back = page.getByRole("button", { name: "Go back" });
  await expect(back).toBeInViewport();
  return { title, back };
}

/** The open panel must not scroll sideways, and neither may the document. */
export async function expectNoHorizontalOverflow(title: Locator) {
  await expect
    .poll(() =>
      title.evaluate((el) => {
        const panel = el.closest(".scrollbar-container");
        const doc = document.documentElement;
        return {
          panel: panel ? panel.scrollWidth - panel.clientWidth : -1,
          doc: doc.scrollWidth - window.innerWidth,
        };
      }),
    )
    .toEqual({ panel: 0, doc: 0 });
}

/** A control is usable on the phone when it sits fully inside the viewport width. */
export async function expectWithinPhoneWidth(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const width = locator.page().viewportSize()!.width;
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      return box !== null && box.x >= 0 && box.x + box.width <= width;
    })
    .toBe(true);
}

/** Two frames let React flush effects and the renders they trigger. */
export async function settleFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
