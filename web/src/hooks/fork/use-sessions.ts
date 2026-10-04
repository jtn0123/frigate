/**
 * Fork (E26): the signed-in sessions list, its revoke actions, and the words
 * a row shows (device name, sign-in age, last activity).
 *
 * Settings > Users and the account menu's dialog read the same SWR key, so a
 * revoke in one shows in the other.
 */

import { useCallback } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { useApi } from "@/api/fork/client";
import { useInlineReadError } from "@/hooks/fork/use-inline-read-error";
import { useDateLocale } from "@/hooks/use-date-locale";
import { useTimezone } from "@/hooks/use-date-utils";
import {
  ACTIVE_NOW_SECONDS,
  parseUserAgent,
  sessionAge,
  type SessionAge,
  type SessionDevice,
} from "@/lib/fork/sessions";
import type { components } from "@/types/fork/api.gen";
import type { FrigateConfig, UiConfig } from "@/types/frigateConfig";
import { formatUnixTimestampToDateTime } from "@/utils/dateUtil";

export type SessionItem = components["schemas"]["SessionListItem"];
type RevokeAllResponse = components["schemas"]["SessionRevokeAllResponse"];

/** How often an open list re-reads, so activity and new sign-ins show. */
const REFRESH_MS = 30_000;

export function useSessions(enabled: boolean) {
  const sessions = useApi(enabled ? "/fork/sessions" : null, {
    refreshInterval: REFRESH_MS,
  });
  // the list draws its own error with a retry, not a toast too
  useInlineReadError("fork/sessions");
  const { mutate } = sessions;

  /**
   * Revoke one session. A 404 means it already ended or expired, which is
   * what was asked for, so it counts as done.
   */
  const revoke = useCallback(
    async (id: string) => {
      try {
        await axios.delete(`fork/sessions/${encodeURIComponent(id)}`);
      } catch (error) {
        if (!(axios.isAxiosError(error) && error.response?.status === 404)) {
          // the list may be what is out of date, so read it again
          void mutate();
          throw error;
        }
      }
      await mutate((list) => list?.filter((session) => session.id !== id), {
        revalidate: true,
      });
    },
    [mutate],
  );

  /** Sign a user out everywhere, or everywhere but here. Returns the count. */
  const revokeAll = useCallback(
    async (username: string, keepCurrent: boolean) => {
      try {
        const { data } = await axios.post<RevokeAllResponse>(
          "fork/sessions/revoke_all",
          { username, keep_current: keepCurrent },
        );
        return data.revoked;
      } finally {
        void mutate();
      }
    },
    [mutate],
  );

  return { ...sessions, revoke, revokeAll };
}

/** Translated text for a session row and its confirmations. */
export function useSessionText() {
  const { t } = useTranslation(["fork"]);
  const { data: config } = useSWR<FrigateConfig>("config");
  const timezone = useTimezone(config);
  const locale = useDateLocale();

  const deviceName = useCallback(
    (device: SessionDevice) => {
      if (device.app) {
        return device.os
          ? t("sessions.device.appOn", { app: device.app, os: device.os })
          : device.app;
      }
      if (device.browser) {
        return device.os
          ? t("sessions.device.browserOn", {
              browser: device.browser,
              os: device.os,
            })
          : device.browser;
      }
      if (device.os) {
        return t("sessions.device.someBrowserOn", { os: device.os });
      }
      return t("sessions.device.unknown");
    },
    [t],
  );

  // One literal key per unit, in the scope of useTranslation, so the i18n
  // extractor finds the plural forms in the fork namespace.
  const signedIn = useCallback(
    (age: SessionAge) => {
      switch (age.unit) {
        case "now":
          return t("sessions.signedIn.now");
        case "minutes":
          return t("sessions.signedIn.minutes", { count: age.count });
        case "hours":
          return t("sessions.signedIn.hours", { count: age.count });
        case "days":
          return t("sessions.signedIn.days", { count: age.count });
      }
    },
    [t],
  );

  const lastActive = useCallback(
    (age: SessionAge) => {
      switch (age.unit) {
        case "now":
          return t("sessions.lastActive.now");
        case "minutes":
          return t("sessions.lastActive.minutes", { count: age.count });
        case "hours":
          return t("sessions.lastActive.hours", { count: age.count });
        case "days":
          return t("sessions.lastActive.days", { count: age.count });
      }
    },
    [t],
  );

  // a partial config (an older server, a test double) may leave out `ui`
  const ui: Partial<UiConfig> | undefined = config?.ui;
  const timeFormat = ui?.time_format;
  const exactTime = useCallback(
    (at: number) =>
      formatUnixTimestampToDateTime(at, {
        ...(timezone === undefined ? {} : { timezone }),
        ...(timeFormat === undefined ? {} : { time_format: timeFormat }),
        date_style: "medium",
        time_style: "short",
        locale,
      }),
    [locale, timeFormat, timezone],
  );

  /** Everything a row shows about one session, at `now` (unix seconds). */
  const describe = useCallback(
    (session: SessionItem, now: number) => {
      const device = parseUserAgent(session.user_agent);
      return {
        device,
        name: deviceName(device),
        signedIn: signedIn(sessionAge(session.created_at, now)),
        signedInAt: exactTime(session.created_at),
        lastActive: lastActive(
          sessionAge(session.last_seen, now, ACTIVE_NOW_SECONDS),
        ),
        lastActiveAt: exactTime(session.last_seen),
      };
    },
    [deviceName, exactTime, lastActive, signedIn],
  );

  return { describe };
}

export type SessionText = ReturnType<
  ReturnType<typeof useSessionText>["describe"]
>;
