/**
 * Fork (E26): one signed-in session. Names the device from its user agent,
 * then the address it signed in from, when it signed in and when it was
 * last active. The session in use here gets a badge instead of Revoke.
 *
 * An address every session shares is a proxy's, not the device's; it reads
 * as "from <address>" in the normal font, since it says nothing to tell the
 * rows apart (the list explains it once above).
 */

import type { IconType } from "react-icons";
import {
  LuCircleHelp,
  LuHouse,
  LuMonitor,
  LuSmartphone,
  LuTablet,
  LuTerminal,
} from "react-icons/lu";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SessionItem, SessionText } from "@/hooks/fork/use-sessions";
import type { SessionDevice } from "@/lib/fork/sessions";

function deviceIcon(device: SessionDevice): IconType {
  switch (device.kind) {
    case "desktop":
      return LuMonitor;
    case "phone":
      return LuSmartphone;
    case "tablet":
      return LuTablet;
    case "app":
      return device.app === "Home Assistant" ? LuHouse : LuTerminal;
    case "unknown":
      return LuCircleHelp;
  }
}

type SessionRowProps = {
  session: SessionItem;
  /** What `useSessionText().describe` says about the session. */
  text: SessionText;
  /** A revoke is running, here or elsewhere in the list. */
  disabled: boolean;
  /** This row's revoke is the one running. */
  revoking: boolean;
  /** The address is the proxy every session comes through. */
  proxied?: boolean;
  onRevoke: (session: SessionItem) => void;
};

export default function SessionRow({
  session,
  text,
  disabled,
  revoking,
  proxied = false,
  onRevoke,
}: Readonly<SessionRowProps>) {
  const { t } = useTranslation(["fork"]);
  const Icon = deviceIcon(text.device);

  return (
    <li
      className="flex items-center gap-3 py-2"
      data-testid="session-row"
      data-current={session.current ? "true" : undefined}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium">{text.name}</span>
          {session.current && (
            <Badge
              variant="secondary"
              // the dark theme's secondary text is 2.8:1 on this badge
              className="dark:text-primary-variant"
              data-testid="session-this-device"
            >
              {t("sessions.thisDevice")}
            </Badge>
          )}
        </div>
        {/* each part stays whole, so a narrow row wraps between them */}
        <p className="text-xs text-muted-foreground">
          {session.ip && (
            <>
              {proxied ? (
                <span className="whitespace-nowrap">
                  {t("sessions.from", { ip: session.ip })}
                </span>
              ) : (
                <span className="font-mono">{session.ip}</span>
              )}
              {" · "}
            </>
          )}
          <span className="whitespace-nowrap" title={text.signedInAt}>
            {text.signedIn}
          </span>
          {" · "}
          <span className="whitespace-nowrap" title={text.lastActiveAt}>
            {text.lastActive}
          </span>
        </p>
      </div>
      {!session.current && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          // the default theme's --ring is not a valid color, so the stock
          // focus ring draws nothing; this one shows for keyboard users
          className="shrink-0 focus-visible:ring-selected"
          disabled={disabled}
          aria-label={t("sessions.revokeLabel", {
            device: text.name,
            user: session.username,
          })}
          onClick={() => onRevoke(session)}
        >
          {revoking ? t("sessions.revoking") : t("sessions.revoke")}
        </Button>
      )}
    </li>
  );
}
