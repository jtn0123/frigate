/**
 * Fork (E26): the account menu entry that opens the signed-in user's
 * sessions. Rendered by both account menus with their own item component,
 * and only when sign-in is on and someone is signed in.
 */

import type { ElementType } from "react";
import { LuMonitorSmartphone } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { isForkEnabled } from "@/fork/flags";
import type { FrigateConfig } from "@/types/frigateConfig";

type SessionsMenuItemProps = {
  /** The menu's item component (a dropdown item, or a drawer close). */
  as: ElementType;
  className?: string;
  onOpen: () => void;
};

export default function SessionsMenuItem({
  as: Item,
  className,
  onOpen,
}: Readonly<SessionsMenuItemProps>) {
  const { t } = useTranslation(["fork"]);
  const { data: profile } = useSWR<{ username?: string }>("profile");
  const { data: config } = useSWR<FrigateConfig>("config");

  if (
    !isForkEnabled("userSessions") ||
    config?.auth.enabled === false ||
    !profile?.username ||
    profile.username === "anonymous"
  ) {
    return null;
  }

  return (
    <Item
      className={className}
      aria-label={t("sessions.menu")}
      data-testid="sessions-menu-item"
      onClick={onOpen}
    >
      <LuMonitorSmartphone className="mr-2 size-4" />
      <span>{t("sessions.menu")}</span>
    </Item>
  );
}
