/**
 * Fork (E27): the web app's side of a session ending.
 *
 * nginx checks the session once per websocket, when it opens, so revoking a
 * session would leave this page's live connection, and the live video it
 * plays, running. Instead the server closes the session's `/ws` connection
 * with code 4401 (frigate/fork/session_reach.py). The page then checks
 * whether it is still signed in. A password change on this device has
 * already signed it in again with a new cookie, so the profile loads and the
 * socket simply reconnects. Otherwise it goes to the login page, which ends
 * the live video too.
 *
 * Each time the socket opens, this browser's push subscription, if it has
 * one, is tied to the session signed in now. Signing this device out then
 * stops its notifications, and signing in again restores them.
 */

import axios from "axios";
import { baseUrl } from "@/api/baseUrl";
import {
  isRedirectingToLogin,
  setRedirectingToLogin,
} from "@/api/auth-redirect";
import { isForkEnabled } from "@/fork/flags";

/** The close code the server sends when the session ended. */
export const SESSION_ENDED_CLOSE_CODE = 4401;
/** Long enough for a password change's new cookie to arrive first. */
export const SESSION_CHECK_DELAY_MS = 1000;
// the worker the notification settings register for push
const NOTIFICATION_SERVICE_WORKER = "/notifications-worker.js";

function goTo(url: string) {
  window.location.href = url;
}

/** Go to the login page if this page is no longer signed in. */
export async function leaveIfSignedOut(
  navigate: (url: string) => void = goTo,
): Promise<void> {
  try {
    await axios.get("profile");
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      !isRedirectingToLogin()
    ) {
      setRedirectingToLogin(true);
      navigate(`${baseUrl}login`);
    }
    // anything else: the socket's own reconnects try again
  }
}

/** Tie this browser's push subscription, if any, to the current session. */
export async function linkPushSubscription(): Promise<void> {
  // there are no service workers outside a secure context
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration(
      NOTIFICATION_SERVICE_WORKER,
    );
    const subscription = await registration?.pushManager.getSubscription();

    if (subscription) {
      await axios.put("fork/sessions/push", { sub: subscription.toJSON() });
    }
  } catch {
    // notifications work as they did; the next connection tries again
  }
}

/** Follow a `/ws` connection for the session it was opened with. */
export function watchSession(ws: WebSocket): void {
  if (!isForkEnabled("userSessions")) {
    return;
  }

  ws.addEventListener("open", () => {
    void linkPushSubscription();
  });
  ws.addEventListener("close", (event) => {
    if (event.code === SESSION_ENDED_CLOSE_CODE) {
      setTimeout(() => void leaveIfSignedOut(), SESSION_CHECK_DELAY_MS);
    }
  });
}
