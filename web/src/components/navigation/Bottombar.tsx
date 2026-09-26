import NavItem from "./NavItem";
import { IoIosWarning } from "react-icons/io";
import { Drawer, DrawerContent, DrawerTrigger } from "../ui/drawer";
import { Suspense, lazy, useLayoutEffect, useRef, useState } from "react";
import useStatusMessages from "@/hooks/use-status-messages";
import StatusMessageList from "../StatusMessageList";
import { useIsAdmin } from "@/hooks/use-is-admin";
import useNavigation from "@/hooks/use-navigation";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/fork/use-viewport";
import { isPWA } from "@/utils/isPWA";
import { useTranslation } from "react-i18next";
import ForkNavItems from "@/components/fork/ForkNavItems";
import { phoneShell } from "@/lib/fork/phone-shell";

// not needed for first paint, so it loads after the shell
const GeneralSettings = lazy(() => import("../menu/GeneralSettings"));

function Bottombar() {
  const isMobile = useIsMobile();
  const navItems = useNavigation("secondary");

  // Render 48px touch targets when they fit with even spacing, otherwise fall
  // back to the compact size. Measured against the live bar width and icon
  // count (which varies with enabled nav items and the status alert).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [large, setLarge] = useState(false);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }

    const TARGET = 48; // standard bottom-nav touch target (px)
    const MIN_GAP = 8; // minimum spacing between targets (px)

    const compute = () => {
      const count = el.children.length;
      if (count === 0) {
        return;
      }
      const needed = count * TARGET + Math.max(count - 1, 0) * MIN_GAP;
      setLarge(needed <= el.clientWidth);
    };

    compute();

    const resize = new ResizeObserver(compute);
    resize.observe(el);
    // recompute when items are added/removed (e.g. the status alert appears)
    const mutation = new MutationObserver(compute);
    mutation.observe(el, { childList: true });

    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [navItems]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute inset-x-4 bottom-0 flex h-16 flex-row items-center justify-between",
        isMobile &&
          // fork: phoneShell reserves insets in a tab and stays compact in landscape
          (phoneShell?.bar ??
            (isPWA
              ? "h-[calc(3rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] md:h-[calc(4rem+env(safe-area-inset-bottom))]"
              : "h-12 md:h-16 md:pb-2")),
      )}
    >
      {navItems.map((item) => (
        <NavItem
          key={item.id}
          large={large}
          className="p-2"
          item={item}
          Icon={item.icon}
        />
      ))}
      <Suspense
        fallback={<div className={cn("p-2", large ? "size-12" : "size-9")} />}
      >
        <GeneralSettings large={large} className="p-2" />
      </Suspense>
      <ForkNavItems variant="bottombar" large={large} />
      <StatusAlertNav large={large} className="p-2" />
    </div>
  );
}

type StatusAlertNavProps = {
  className?: string;
  large?: boolean;
};
function StatusAlertNav({ className, large }: Readonly<StatusAlertNavProps>) {
  const messages = useStatusMessages();
  const { t } = useTranslation(["views/system", "fork"]);
  const issueCount = messages.length;

  const isAdmin = useIsAdmin();

  // problems link to admin-only pages
  if (!isAdmin || messages.length === 0) {
    return;
  }

  return (
    <Drawer>
      <DrawerTrigger asChild>
        {/* fork: a named button, not a div carrying button-only ARIA */}
        <button
          type="button"
          data-testid="status-alert-trigger"
          aria-label={t("statusAlerts.label", { ns: "fork" })}
          aria-haspopup="dialog"
          className={cn(
            // fork (UI127): the alarm shares a row with six destinations, so
            // it is set off by a divider, carries its count, and announces
            // that it opens a sheet rather than navigating somewhere
            "relative ml-1 flex flex-col items-center justify-center border-l border-secondary-highlight p-2 pl-3",
            large && "size-12",
          )}
        >
          <IoIosWarning
            className={cn(
              "text-danger md:m-[6px]",
              large ? "size-6" : "size-5",
            )}
          />
          <span className="absolute right-0 top-0 min-w-4 rounded-full bg-danger px-1 text-[10px] font-medium leading-4 text-white">
            <span aria-hidden>{issueCount}</span>
            <span className="sr-only">
              {t("statusAlerts.count", { ns: "fork", count: issueCount })}
            </span>
          </span>
        </button>
      </DrawerTrigger>
      <DrawerContent
        className={cn(
          "mx-1 max-h-[75dvh] overflow-hidden rounded-t-2xl",
          className,
        )}
      >
        <StatusMessageList
          messages={messages}
          className="scrollbar-container w-full overflow-y-auto overflow-x-hidden px-4 py-4"
        />
      </DrawerContent>
    </Drawer>
  );
}

export default Bottombar;
