/**
 * Fork (E26): signed-in sessions, listed and revoked.
 *
 * Settings > Users lists every user's sessions grouped by user, with Revoke
 * and "Sign out everywhere". The account menu opens the signed-in user's
 * own sessions with "Sign out other sessions". The server is a small
 * in-memory stand-in that answers like the real routes.
 *
 * Fork (E27): when a session ends elsewhere, the server closes its /ws
 * connection with code 4401 and the page leaves for the login page.
 */

import type { Page, Request, WebSocketRoute } from "@playwright/test";
import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";

const NOW = Date.now() / 1000;
const DAY = 86400;

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const HOME_ASSISTANT = "HomeAssistant/2024.10.1 aiohttp/3.10.5 Python/3.12";

type Session = {
  id: string;
  username: string;
  created_at: number;
  last_seen: number;
  expires_at: number;
  user_agent: string;
  ip: string;
  current: boolean;
};

function session(
  id: string,
  username: string,
  userAgent: string,
  ip: string,
  signedInAgo: number,
  activeAgo: number,
  current = false,
): Session {
  return {
    id,
    username,
    created_at: NOW - signedInAgo,
    last_seen: NOW - activeAgo,
    expires_at: NOW + DAY,
    user_agent: userAgent,
    ip,
    current,
  };
}

const SESSIONS: Session[] = [
  session("admin-mac", "admin", CHROME_MAC, "192.168.1.20", 3 * DAY, 5, true),
  session("admin-iphone", "admin", SAFARI_IPHONE, "192.168.1.31", 7200, 1500),
  session("bob-android", "bob", CHROME_ANDROID, "192.168.1.44", DAY, 600),
  session("bob-ha", "bob", HOME_ASSISTANT, "192.168.1.5", 5 * DAY, 30),
  session(
    "alice-script",
    "alice",
    "python-requests/2.32.3",
    "10.0.0.8",
    3600,
    3000,
  ),
];

const USERS = [
  { username: "admin", role: "admin" },
  { username: "alice", role: "viewer" },
  { username: "bob", role: "viewer" },
];

/**
 * Answer the session routes from a list the test can inspect: a revoke
 * removes the row, "sign out" removes the user's rows (but the caller's
 * own when asked to keep it). Register after `installDefaults`, whose
 * default route would otherwise answer first.
 */
async function serveSessions(
  page: Page,
  options: { failRevoke?: boolean; extra?: Session[]; ip?: string } = {},
) {
  let sessions = [...SESSIONS, ...(options.extra ?? [])].map((row) => ({
    ...row,
    ...(options.ip === undefined ? {} : { ip: options.ip }),
  }));
  const writes: Request[] = [];

  await page.route("**/api/fork/sessions**", async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === "GET") {
      return route.fulfill({ json: sessions });
    }
    writes.push(request);
    if (method === "DELETE") {
      if (options.failRevoke) {
        return route.fulfill({
          status: 500,
          json: { success: false, message: "Sessions are unavailable" },
        });
      }
      const id = decodeURIComponent(request.url().split("/").pop() ?? "");
      sessions = sessions.filter((row) => row.id !== id);
      return route.fulfill({
        json: { success: true, message: "Session revoked" },
      });
    }
    const body = request.postDataJSON() as {
      username: string;
      keep_current: boolean;
    };
    const ended = sessions.filter(
      (row) =>
        row.username === body.username && !(body.keep_current && row.current),
    );
    sessions = sessions.filter((row) => !ended.includes(row));
    return route.fulfill({ json: { success: true, revoked: ended.length } });
  });

  return { writes, rows: () => sessions };
}

async function openUsersSettings(
  frigateApp: FrigateApp,
  options: { failRevoke?: boolean; ip?: string } = {},
) {
  await frigateApp.installDefaults({ users: USERS });
  const server = await serveSessions(frigateApp.page, options);
  await frigateApp.goto("/settings?page=users");
  const section = frigateApp.page.getByTestId("sessions-settings");
  await expect(section).toBeVisible({ timeout: 10_000 });
  return { section, server };
}

test.describe("Signed-in sessions (E26) @high", () => {
  test("Settings > Users lists everyone's sessions by user and device", async ({
    frigateApp,
  }) => {
    const { section } = await openUsersSettings(frigateApp);

    const groups = section.getByTestId("session-group");
    await expect(groups).toHaveCount(3);
    // the signed-in admin first, then everyone by name
    await expect(groups.nth(0)).toContainText("admin");
    await expect(groups.nth(0)).toContainText("(you)");
    await expect(groups.nth(1)).toContainText("alice");
    await expect(groups.nth(2)).toContainText("bob");

    const mine = groups.nth(0).getByTestId("session-row");
    await expect(mine.nth(0)).toContainText("Chrome on macOS");
    await expect(mine.nth(0)).toContainText("This device");
    await expect(mine.nth(0)).toContainText("192.168.1.20");
    // every device has its own address, so no proxy hint
    await expect(section.getByTestId("sessions-proxy-hint")).toHaveCount(0);
    await expect(mine.nth(0)).toContainText("Signed in 3 days ago");
    await expect(mine.nth(0)).toContainText("Active now");
    // the session in use here cannot be revoked from the list
    await expect(mine.nth(0).getByRole("button")).toHaveCount(0);
    await expect(mine.nth(1)).toContainText("Safari on iOS");
    await expect(mine.nth(1)).toContainText("Active 25 minutes ago");

    await expect(groups.nth(1)).toContainText("Python requests");
    await expect(groups.nth(2)).toContainText("Home Assistant");
    await expect(groups.nth(2)).toContainText("Chrome on Android");
    await expect(groups.nth(2)).toContainText("2 sessions");

    // own group signs out the others; anyone else's signs out everywhere
    await expect(
      groups.nth(0).getByRole("button", { name: "Sign out other sessions" }),
    ).toBeVisible();
    await expect(
      groups.nth(2).getByRole("button", { name: "Sign out bob everywhere" }),
    ).toBeVisible();
  });

  test("behind a proxy, the list says why every device has its address", async ({
    frigateApp,
  }) => {
    const { section } = await openUsersSettings(frigateApp, {
      ip: "172.22.0.1",
    });

    const hint = section.getByTestId("sessions-proxy-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("172.22.0.1");
    await expect(hint).toContainText("auth.trusted_proxies");
    await expect(section.getByTestId("session-row").first()).toContainText(
      "from 172.22.0.1",
    );
  });

  test(
    "the password and role dialogs say whose devices are signed out",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await openUsersSettings(frigateApp);
      const { page } = frigateApp;
      const bob = page.getByRole("row").filter({ hasText: "bob" });

      // Settings > Users does not tell the password dialog whose it is,
      // so the notice must not claim it is the admin's own
      await bob.getByRole("button", { name: "Reset Password" }).click();
      const notice = page
        .getByRole("dialog")
        .getByTestId("sessions-end-notice");
      await expect(notice).toHaveText(
        "Saving signs this account out of every device at once. If it is your own, this device stays signed in.",
      );
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await bob.getByRole("button", { name: "Role" }).click();
      await expect(
        page.getByRole("dialog").getByTestId("sessions-end-notice"),
      ).toHaveText(
        "Saving signs bob out of every device, to sign in again with the new role.",
      );
    },
  );

  test("Revoke asks first, then removes the session", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const { section, server } = await openUsersSettings(frigateApp);

    await section
      .getByRole("button", { name: "Revoke Chrome on Android for bob" })
      .click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Revoke this session?");
    await expect(confirm).toContainText(
      "Chrome on Android signed in as bob will be signed out",
    );
    expect(server.writes).toHaveLength(0);

    await confirm.getByRole("button", { name: "Revoke" }).click();

    await expect(page.getByText("Session revoked")).toBeVisible();
    await expect(section).not.toContainText("Chrome on Android");
    await expect(section).toContainText("Home Assistant");
    expect(server.writes.map((request) => request.url())).toEqual([
      expect.stringMatching(/\/api\/fork\/sessions\/bob-android$/),
    ]);
  });

  test("Cancel leaves the session alone", async ({ frigateApp }) => {
    const { page } = frigateApp;
    const { section, server } = await openUsersSettings(frigateApp);

    await section
      .getByRole("button", { name: "Revoke Python requests for alice" })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Cancel" })
      .click();

    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(section).toContainText("Python requests");
    expect(server.writes).toHaveLength(0);
  });

  test("Sign out everywhere ends every session of that user", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const { section, server } = await openUsersSettings(frigateApp);

    await section
      .getByRole("button", { name: "Sign out bob everywhere" })
      .click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Sign out bob everywhere?");
    await confirm.getByRole("button", { name: "Sign out everywhere" }).click();

    await expect(page.getByText("Signed out 2 sessions")).toBeVisible();
    await expect(section.getByTestId("session-group")).toHaveCount(2);
    await expect(section).not.toContainText("Home Assistant");
    expect(server.writes.map((request) => request.postDataJSON())).toEqual([
      { username: "bob", keep_current: false },
    ]);
  });

  test.describe("when the server fails", () => {
    test.use({
      expectedErrors: [
        /Failed to load resource.*500|500.*\/api\/fork\/sessions/,
      ],
    });

    test("a failed revoke says so and keeps the session", async ({
      frigateApp,
    }) => {
      const { page } = frigateApp;
      const { section } = await openUsersSettings(frigateApp, {
        failRevoke: true,
      });

      await section
        .getByRole("button", { name: "Revoke Safari on iOS for admin" })
        .click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Revoke" })
        .click();

      await expect(
        page.getByText("Could not revoke the session"),
      ).toBeVisible();
      await expect(section).toContainText("Safari on iOS");
    });

    test("a failed read offers a retry", async ({ frigateApp }) => {
      const { page } = frigateApp;
      let fail = true;
      await frigateApp.installDefaults({ users: USERS });
      await page.route("**/api/fork/sessions**", (route) =>
        fail
          ? route.fulfill({ status: 500, json: { success: false } })
          : route.fulfill({ json: SESSIONS }),
      );
      await frigateApp.goto("/settings?page=users");

      const section = page.getByTestId("sessions-settings");
      const alert = section.getByRole("alert");
      await expect(alert).toContainText("Could not load sessions", {
        timeout: 15_000,
      });
      fail = false;
      await alert.getByRole("button", { name: "Retry" }).click();

      await expect(section.getByTestId("session-group")).toHaveCount(3);
    });
  });

  test(
    "the account menu signs out the other sessions",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const server = await serveSessions(page);
      await frigateApp.goto("/");

      await page.getByRole("button", { name: "Account", exact: true }).click();
      await page.getByRole("menuitem", { name: "Signed-in devices" }).click();

      const dialog = page.getByTestId("my-sessions-dialog");
      await expect(dialog).toContainText("Your signed-in devices");
      // only the signed-in user's own sessions
      await expect(dialog.getByTestId("session-row")).toHaveCount(2);
      await expect(dialog).not.toContainText("Home Assistant");

      await dialog
        .getByRole("button", { name: "Sign out other sessions" })
        .click();
      const confirm = page.getByRole("alertdialog");
      await expect(confirm).toContainText(
        "1 other session will be signed out. This device stays signed in.",
      );
      await confirm
        .getByRole("button", { name: "Sign out other sessions" })
        .click();

      // reported inside the dialog: a page's toasts sit under its overlay
      await expect(dialog.getByTestId("sessions-feedback")).toHaveText(
        "Signed out 1 session",
      );
      await expect(dialog.getByTestId("session-row")).toHaveCount(1);
      await expect(dialog).toContainText("This device");
      await expect(
        dialog.getByRole("button", { name: "Sign out other sessions" }),
      ).toHaveCount(0);
      expect(server.writes.map((request) => request.postDataJSON())).toEqual([
        { username: "admin", keep_current: true },
      ]);
    },
  );

  test(
    "a long list folds, so the dialog's action stays in reach",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      // a script that signs in on every run leaves one session per run
      const runs = Array.from({ length: 40 }, (_, index) =>
        session(
          `admin-run-${index}`,
          "admin",
          "python-requests/2.32.3",
          "172.22.0.1",
          600 + index * 60,
          600 + index * 60,
        ),
      );
      await serveSessions(page, { extra: runs });
      await frigateApp.goto("/");

      await page.getByRole("button", { name: "Account", exact: true }).click();
      await page.getByRole("menuitem", { name: "Signed-in devices" }).click();

      const dialog = page.getByTestId("my-sessions-dialog");
      await expect(dialog.getByTestId("session-row")).toHaveCount(5);
      await expect(dialog.getByTestId("session-row").first()).toContainText(
        "This device",
      );
      await expect(
        dialog.getByRole("button", { name: "Sign out other sessions" }),
      ).toBeInViewport();

      await dialog.getByRole("button", { name: "Show 37 more" }).click();
      await expect(dialog.getByTestId("session-row")).toHaveCount(42);
      await expect(
        dialog.getByRole("button", { name: "Show fewer" }),
      ).toHaveAttribute("aria-expanded", "true");
    },
  );

  test(
    "@mobile the settings drawer opens the signed-in devices",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const server = await serveSessions(page);
      await frigateApp.goto("/");

      await page.getByRole("button", { name: "Settings" }).first().click();
      await page.getByLabel("Signed-in devices").click();

      const dialog = page.getByTestId("my-sessions-dialog");
      await expect(dialog.getByTestId("session-row")).toHaveCount(2);
      await dialog
        .getByRole("button", { name: "Revoke Safari on iOS for admin" })
        .click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Revoke" })
        .click();

      await expect(dialog.getByTestId("session-row")).toHaveCount(1);
      expect(server.rows().map((row) => row.id)).not.toContain("admin-iphone");

      // the dialog fits the phone: no sideways scroll
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        page.viewportSize()?.width ?? 0,
      );
    },
  );

  test(
    "@mobile Settings > Users fits the phone",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const { section } = await openUsersSettings(frigateApp);

      await expect(section.getByTestId("session-group")).toHaveCount(3);
      // the phone's settings page slides in from the side; measure once it lands
      await expect
        .poll(async () => (await section.boundingBox())?.x ?? Infinity)
        .toBeLessThan(48);
      const overflow = await section.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      // every action stays inside the screen's width
      const width = page.viewportSize()?.width ?? 0;
      for (const button of await section.getByRole("button").all()) {
        const box = await button.boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      }
    },
  );

  test.describe("when the server ends this page's session (E27)", () => {
    // the sign-in check after the close answers 401, as a revoked token does
    test.use({ expectedErrors: [/Failed to load resource.*401/] });

    async function openLive(frigateApp: FrigateApp) {
      const { page } = frigateApp;
      await frigateApp.installDefaults({ users: USERS });
      const sockets: WebSocketRoute[] = [];
      // registered after the defaults, so this one answers /ws
      await page.routeWebSocket("**/ws", (ws) => {
        sockets.push(ws);
      });
      await frigateApp.goto("/");
      await expect.poll(() => sockets.length).toBe(1);
      return sockets;
    }

    test("a revoked page leaves for the login page", async ({ frigateApp }) => {
      const { page } = frigateApp;
      const sockets = await openLive(frigateApp);
      await page.route("**/api/profile", (route) =>
        route.fulfill({ status: 401, json: { message: "Unauthorized" } }),
      );

      await sockets[0]?.close({ code: 4401, reason: "session ended" });

      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    });

    test("a page still signed in reconnects instead", async ({
      frigateApp,
    }) => {
      const { page } = frigateApp;
      const sockets = await openLive(frigateApp);

      // as after a password change made here: the new cookie is already set
      await sockets[0]?.close({ code: 4401, reason: "session ended" });

      await expect.poll(() => sockets.length, { timeout: 10_000 }).toBe(2);
      expect(new URL(page.url()).pathname).toBe("/");
    });
  });
});
