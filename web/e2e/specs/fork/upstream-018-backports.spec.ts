/**
 * Fork B33: upstream 0.18.x app fixes.
 *
 * - #24622: the camera group edit button on the live grid is admin only.
 * - #24407: a failed embeddings reindex is reported in the status bar.
 * - #24392: Explore pages non-date sorts by offset instead of a start_time
 *   cursor, which dropped and repeated rows for score and speed sorts.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../../fixtures/frigate-test";
import { viewerProfile } from "../../fixtures/mock-data/profile";
import { openStatusIssues } from "../../helpers/status-issues";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_EVENT = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../fixtures/mock-data/events.json"),
    "utf-8",
  ),
)[0] as { start_time: number };

const EDIT_GROUP = { name: "Edit Camera Group", exact: true };

test.describe("Live grid camera group edit button (B33) @high", () => {
  test(
    "admins see the edit button on a group grid",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/?group=outdoor");
      await expect(
        frigateApp.page.getByRole("button", { name: "Edit Layout" }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(frigateApp.page.getByRole("button", EDIT_GROUP)).toHaveCount(
        1,
      );
    },
  );

  test(
    "viewers do not see the edit button on a group grid",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.installDefaults({ profile: viewerProfile() });
      await frigateApp.goto("/?group=outdoor");
      // the layout button renders next to it for every role
      await expect(
        frigateApp.page.getByRole("button", { name: "Edit Layout" }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(frigateApp.page.getByRole("button", EDIT_GROUP)).toHaveCount(
        0,
      );
    },
  );
});

test.describe("Embeddings reindex failure (B33) @high", () => {
  test(
    "a failed reindex is listed in the status bar",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      // a push that lands before the connect frame is overwritten by it, so
      // resend until the message shows
      await expect(async () => {
        frigateApp.ws.send(
          "embeddings_reindex_progress",
          JSON.stringify({ status: "failed" }),
        );
        const list = await openStatusIssues(frigateApp.page);
        await expect(
          list.getByText("Reindexing embeddings failed, check the logs"),
        ).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
    },
  );
});

test.describe("Explore paging for non-date sorts (B33) @high", () => {
  const API_LIMIT = 25;

  function page(offset: number): unknown[] {
    return Array.from({ length: API_LIMIT }, (_, i) => ({
      ...BASE_EVENT,
      id: `paged-${offset + i}`,
      start_time: BASE_EVENT.start_time - (offset + i) * 60,
    }));
  }

  test("a score sort requests later pages by offset", async ({
    frigateApp,
  }) => {
    const requests: URL[] = [];
    await frigateApp.page.route(/\/api\/events\?/, async (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      await route.fulfill({ json: offset >= API_LIMIT ? [] : page(offset) });
    });

    await frigateApp.goto("/explore?sort=score_desc&labels=person");
    await expect.poll(() => requests.length, { timeout: 10_000 }).toBe(1);

    // scroll to the end of the grid to load the next page
    await expect(async () => {
      await frigateApp.page.mouse.move(400, 400);
      await frigateApp.page.mouse.wheel(0, 20_000);
      expect(requests.length).toBeGreaterThan(1);
    }).toPass({ timeout: 15_000 });

    const next = requests[1];
    expect(next.searchParams.get("offset")).toBe(String(API_LIMIT));
    expect(next.searchParams.get("before")).toBeNull();
    expect(next.searchParams.get("sort")).toBe("score_desc");
  });
});
