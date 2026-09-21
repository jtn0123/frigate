/**
 * Fork: one place that decides when a navigation has finished (item D49).
 *
 * `#pageRoot` belongs to the app shell, so it is in the DOM while the route
 * inside it is still suspended, on its lazy chunk or on one of the 32 i18n
 * namespaces `i18next-http-backend` fetches over HTTP. react-i18next suspends
 * until a namespace lands, so while the route suspense fallback is up every
 * translated accessible name is missing from the page. A navigation that
 * returned at `#pageRoot` handed that page to the test, where a slow fetch
 * read as "element(s) not found" rather than as a page still loading, in
 * whichever spec happened to be running when the machine was busy.
 */

import type { Page } from "@playwright/test";

/** The app shell's container; it renders before the route inside it. */
const PAGE_ROOT = "#pageRoot";

/** `PageLoading`, the fallback of every route-level `<Suspense>`. */
const LOADING = '[data-testid="page-loading"]';

/** The shell renders as soon as the app boots; this is the old budget. */
const SHELL_TIMEOUT = 10_000;

/**
 * The route inside the shell still has to fetch its chunk and its namespaces.
 * Every route is ready inside 2.2 s on an idle machine and `/config`, which
 * carries Monaco, is the slowest; four workers parsing that at once take
 * several times longer, so the budget is the 15 s the heaviest assertions
 * already allowed. Both waits together stay under the 30 s test timeout.
 */
const ROUTE_TIMEOUT = 15_000;

/**
 * Wait until the route content has replaced the suspense fallback.
 *
 * @param page The page that has just navigated
 * @param timeout How long the route may take to render, in ms
 */
export async function waitForAppReady(
  page: Page,
  timeout: number = ROUTE_TIMEOUT,
): Promise<void> {
  await page.waitForSelector(PAGE_ROOT, { timeout: SHELL_TIMEOUT });
  await page.waitForFunction(
    ([root, loading]) => {
      const container = document.querySelector(root);
      return (
        container !== null &&
        container.childElementCount > 0 &&
        container.querySelector(loading) === null
      );
    },
    [PAGE_ROOT, LOADING],
    { timeout },
  );
}
