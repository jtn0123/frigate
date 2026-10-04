/**
 * Session keep-alive for the wall display (UI19, flag `kioskMode`).
 *
 * Requests the user's profile every `intervalMs` (see `keepAliveMs`) so a
 * display that only streams still makes the HTTP requests that renew its
 * session cookie. It uses the app shell's `/profile` read: that read keeps
 * retrying while Frigate restarts (C17), and SWR skips an interval refresh
 * while a read's last attempt failed, so a read that gave up would stop the
 * keep-alive for good. A rejected session sends the display to the login
 * page, like every other read, instead of leaving it on a frozen screen.
 */

import useSWR from "swr";

export function useKioskKeepAlive(intervalMs: number) {
  useSWR(intervalMs > 0 ? "/profile" : null, {
    refreshInterval: intervalMs,
    // A display whose screen or tab is hidden still needs to stay signed in
    // to keep receiving alerts.
    refreshWhenHidden: true,
    // The shell has just read the profile; only the interval asks again.
    revalidateOnMount: false,
    revalidateOnFocus: false,
  });
}
