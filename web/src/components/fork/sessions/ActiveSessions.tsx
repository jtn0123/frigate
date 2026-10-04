/**
 * Fork (E26): the Settings > Users section listing every signed-in session,
 * grouped by user, with Revoke and "Sign out everywhere".
 */

import { useTranslation } from "react-i18next";
import SessionsPanel from "./SessionsPanel";

export default function ActiveSessions() {
  const { t } = useTranslation(["fork"]);

  return (
    <section
      className="mb-6 flex flex-col gap-3 md:mr-3"
      aria-labelledby="sessions-settings-heading"
      data-testid="sessions-settings"
    >
      <div className="flex flex-col items-start">
        {/* the users list's heading style, with an id to label the section */}
        <h4
          id="sessions-settings-heading"
          className="mb-2 scroll-m-20 text-xl font-medium"
        >
          {t("sessions.title")}
        </h4>
        <p className="text-sm text-muted-foreground">
          {t("sessions.description")}
        </p>
      </div>
      <SessionsPanel />
    </section>
  );
}
