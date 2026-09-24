import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { isDesktop } from "react-device-detect";
import { LuBell, LuBellOff } from "react-icons/lu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import ForkNavButton, {
  type ForkNavVariant,
} from "@/components/fork/ForkNavButton";
import { forkNavIconClass } from "@/lib/fork/nav-icon";
import { cn } from "@/lib/utils";
import {
  useInbox,
  useInboxCollector,
  useInboxUnreadCount,
} from "@/hooks/fork/use-inbox";
import { isInQuietHours } from "@/lib/fork/inbox-store";

const InboxPanelBody = lazy(() => import("./InboxPanelBody"));

type InboxBellProps = {
  variant: ForkNavVariant;
  large?: boolean;
};

/**
 * Bell with unread badge that opens the notification inbox panel. Also hosts
 * the WebSocket collector so items are gathered on every page.
 */
export default function InboxBell({
  variant,
  large = false,
}: Readonly<InboxBellProps>) {
  const { t } = useTranslation(["fork"]);
  const [open, setOpen] = useState(false);
  const unread = useInboxUnreadCount();
  const { settings } = useInbox();

  useInboxCollector();

  const quiet = isInQuietHours(settings.quietHours);

  const Container = isDesktop ? Sheet : Drawer;
  const Trigger = isDesktop ? SheetTrigger : DrawerTrigger;
  const Content = isDesktop ? SheetContent : DrawerContent;
  const Header = isDesktop ? SheetHeader : DrawerHeader;
  const Title = isDesktop ? SheetTitle : DrawerTitle;
  const Description = isDesktop ? SheetDescription : DrawerDescription;

  return (
    <Container open={open} onOpenChange={setOpen}>
      <Trigger asChild>
        <ForkNavButton
          variant={variant}
          large={large}
          label={
            unread > 0
              ? t("inbox.openWithUnread", { count: unread })
              : t("inbox.open")
          }
          data-testid="inbox-bell"
        >
          {quiet ? (
            <LuBellOff className={forkNavIconClass(large)} />
          ) : (
            <LuBell className={forkNavIconClass(large)} />
          )}
          {unread > 0 && (
            <span
              data-testid="inbox-unread"
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-selected px-1 text-[10px] font-bold leading-none text-white"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </ForkNavButton>
      </Trigger>
      <Content
        className={cn(
          "flex flex-col gap-0 p-0",
          isDesktop ? "w-[26rem] sm:max-w-[26rem]" : "max-h-[85dvh]",
        )}
        data-testid="inbox-panel"
      >
        <Header className="border-b px-4 py-3 text-left">
          <Title>{t("inbox.title")}</Title>
          <Description className="sr-only">
            {t("inbox.description")}
          </Description>
        </Header>
        <Suspense fallback={null}>
          {open && (
            <InboxPanelBody
              onNavigate={() => {
                setOpen(false);
              }}
            />
          )}
        </Suspense>
      </Content>
    </Container>
  );
}
