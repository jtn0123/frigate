/**
 * Fork (E26): one line in the password and role dialogs saying what saving
 * does to the account's sessions. A password change signs every device out
 * at once (the person changing their own stays signed in here), and so does
 * a role change, since a token carries the role it was signed with.
 *
 * The password dialog only knows the account when someone changes their own
 * from the account menu. Settings > Users opens it without one, for any
 * user, so that case is worded to hold for whichever account it is.
 */

import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { AuthContext } from "@/context/auth-state";
import { isForkEnabled } from "@/fork/flags";

type SessionsEndNoticeProps = {
  /** What the dialog changes. */
  change: "password" | "role";
  /**
   * The account changed. When undefined, a role change means the signed-in
   * user, and a password change means an account the dialog does not name.
   */
  username: string | undefined;
};

export default function SessionsEndNotice({
  change,
  username,
}: Readonly<SessionsEndNoticeProps>) {
  const { t } = useTranslation(["fork"]);
  const { auth } = useContext(AuthContext);

  if (!isForkEnabled("userSessions")) {
    return null;
  }

  let text: string;
  if (change === "role") {
    text = t("sessions.endNotice.role", {
      user: username ?? auth.user?.username,
    });
  } else if (username === undefined) {
    text = t("sessions.endNotice.anyPassword");
  } else if (username === auth.user?.username) {
    text = t("sessions.endNotice.ownPassword");
  } else {
    text = t("sessions.endNotice.password", { user: username });
  }

  return (
    <p
      className="text-sm text-muted-foreground"
      data-testid="sessions-end-notice"
    >
      {text}
    </p>
  );
}
