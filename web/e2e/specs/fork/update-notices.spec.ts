/**
 * Fork: update notices and What's new (UI item 42).
 *
 * GET /api/fork/updates lists the fork's GitHub releases and which one this
 * build is. Admins get an update button when newer releases exist; everyone
 * gets What's new once for each release the browser has not seen, and can
 * reopen it from the command palette.
 */

import { test, expect } from "../../fixtures/frigate-test";
import type { FrigateApp } from "../../fixtures/frigate-test";
import {
  forkRelease,
  forkUpdatesFactory,
} from "../../fixtures/mock-data/fork-updates";
import { viewerProfile } from "../../fixtures/mock-data/profile";

const LAST_SEEN_KEY = "frigateFork.lastSeenRelease";

const LATEST = forkRelease(
  "0.18.0-rc2-20260913.3",
  "### New\n\n- Kiosk mode for wall displays\n\n### Under the hood (1)\n\n- Ratchet the type checks",
  "c".repeat(40),
);
const MIDDLE = forkRelease(
  "0.18.0-rc2-20260912.2",
  "### Fixes and improvements\n\n- Quieter camera restart logs",
  "b".repeat(40),
);
const RUNNING = forkRelease(
  "0.18.0-rc2-20260911.1",
  "### New\n\n- Camera health cards",
  "a".repeat(40),
);
const RELEASES = [LATEST, MIDDLE, RUNNING];

/** The server runs RUNNING while two newer releases exist. */
const BEHIND = forkUpdatesFactory({
  status: "available",
  current_tag: RUNNING.tag,
  current_sha: "aaaaaaaaa",
  latest_tag: LATEST.tag,
  newer_count: 2,
  releases: RELEASES,
});

async function rememberSeen(frigateApp: FrigateApp, tag: string) {
  await frigateApp.page.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    [LAST_SEEN_KEY, tag],
  );
}

async function openPalette(frigateApp: FrigateApp) {
  const { page } = frigateApp;
  if (frigateApp.isMobile) {
    await page.getByTestId("command-palette-hint").click();
  } else {
    await page.keyboard.press("Control+k");
  }
  await expect(page.getByTestId("command-palette")).toBeVisible();
}

test.describe("Update notices @high", () => {
  test("admin opens the newer releases from the update button", async ({
    frigateApp,
  }) => {
    await rememberSeen(frigateApp, RUNNING.tag);
    await frigateApp.installDefaults({ forkUpdates: BEHIND });
    await frigateApp.goto("/");

    const button = frigateApp.page.getByTestId("fork-update-button");
    await expect(button).toHaveAttribute("aria-label", "2 updates available");
    await expect(frigateApp.page.getByTestId("fork-update-count")).toHaveText(
      "2",
    );
    await button.click();

    const dialog = frigateApp.page.getByTestId("fork-release-notes");
    await expect(dialog).toContainText("2 updates are available");
    await expect(dialog.getByTestId("fork-release")).toHaveCount(2);
    await expect(dialog).toContainText("Kiosk mode for wall displays");
    await expect(dialog).toContainText("Quieter camera restart logs");
    await expect(dialog).not.toContainText("Camera health cards");
    await expect(dialog.getByTestId("fork-update-howto")).toContainText(
      "docker compose pull",
    );

    // Tooling-only lines start folded under "Under the hood".
    const hood = dialog.getByTestId("fork-release-hood");
    await expect(hood.getByText("Ratchet the type checks")).toBeHidden();
    await hood.getByText("Under the hood (1)").click();
    await expect(hood.getByText("Ratchet the type checks")).toBeVisible();
  });

  test("What's new shows once for each release the server moves to", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      forkUpdates: forkUpdatesFactory({
        status: "available",
        current_tag: MIDDLE.tag,
        latest_tag: LATEST.tag,
        newer_count: 1,
        releases: RELEASES,
      }),
    });
    await frigateApp.goto("/");

    // First visit: only the running release.
    const dialog = page.getByTestId("fork-release-notes");
    await expect(dialog).toContainText("What's new");
    await expect(dialog.getByTestId("fork-release")).toHaveCount(1);
    await expect(dialog).toContainText("Quieter camera restart logs");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate((key) => localStorage.getItem(key), LAST_SEEN_KEY),
      )
      .toBe(MIDDLE.tag);

    // The server pulls the newest image: only that release is new.
    await page.route("**/api/fork/updates**", (route) =>
      route.fulfill({
        json: forkUpdatesFactory({
          status: "up-to-date",
          current_tag: LATEST.tag,
          latest_tag: LATEST.tag,
          releases: RELEASES,
        }),
      }),
    );
    await frigateApp.goto("/");
    await expect(dialog.getByTestId("fork-release")).toHaveCount(1);
    await expect(dialog).toContainText("Kiosk mode for wall displays");
    await expect(dialog).not.toContainText("Quieter camera restart logs");
  });

  test("What's new lists every release since the last one seen", async ({
    frigateApp,
  }) => {
    await rememberSeen(frigateApp, RUNNING.tag);
    await frigateApp.installDefaults({
      forkUpdates: forkUpdatesFactory({
        status: "up-to-date",
        current_tag: LATEST.tag,
        latest_tag: LATEST.tag,
        releases: RELEASES,
      }),
    });
    await frigateApp.goto("/");

    const dialog = frigateApp.page.getByTestId("fork-release-notes");
    await expect(dialog.getByTestId("fork-release")).toHaveCount(2);
    await expect(dialog).toContainText("Kiosk mode for wall displays");
    await expect(dialog).toContainText("Quieter camera restart logs");
    await expect(dialog.getByTestId("fork-update-howto")).toHaveCount(0);
  });

  test("viewers reopen What's new from the palette but get no update button", async ({
    frigateApp,
  }) => {
    await rememberSeen(frigateApp, RUNNING.tag);
    await frigateApp.installDefaults({
      profile: viewerProfile(),
      forkUpdates: BEHIND,
    });
    await frigateApp.goto("/");

    await openPalette(frigateApp);
    await frigateApp.page.getByRole("option", { name: "What's new" }).click();

    const dialog = frigateApp.page.getByTestId("fork-release-notes");
    await expect(dialog.getByTestId("fork-release")).toHaveCount(1);
    await expect(dialog).toContainText("Camera health cards");
    await expect(frigateApp.page.getByTestId("fork-update-button")).toHaveCount(
      0,
    );
  });

  test("the update button sits in the bottombar on a phone @mobile", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile bottombar flow");
    await rememberSeen(frigateApp, RUNNING.tag);
    await frigateApp.installDefaults({ forkUpdates: BEHIND });
    await frigateApp.goto("/");

    await frigateApp.page.getByTestId("fork-update-button").click();

    const dialog = frigateApp.page.getByTestId("fork-release-notes");
    await expect(dialog.getByTestId("fork-release")).toHaveCount(2);
    await expect(dialog.getByTestId("fork-update-howto")).toBeVisible();
  });
});
