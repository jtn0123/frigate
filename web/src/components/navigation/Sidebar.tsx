import Logo from "../Logo";
import { useTranslation } from "react-i18next";
import NavItem from "./NavItem";
import { Link, useMatch } from "react-router-dom";
import useNavigation from "@/hooks/use-navigation";
import { baseUrl } from "@/api/baseUrl";
import { Suspense, lazy, useMemo } from "react";
import ForkNavItems from "@/components/fork/ForkNavItems";
import NavSearchButton from "@/components/fork/NavSearchButton";
import { isForkEnabled } from "@/fork/flags";
import "@/components/fork/rail-design.css";
import { isRailSearchItem } from "@/lib/fork/nav-search";

// These three pull in the icon picker, forms, motion and the settings menus;
// none of them is needed for first paint, so they load after the shell.
const CameraGroupSelector = lazy(() =>
  import("../filter/CameraGroupSelector").then((module) => ({
    default: module.CameraGroupSelector,
  })),
);
const GeneralSettings = lazy(() => import("../menu/GeneralSettings"));
const AccountSettings = lazy(() => import("../menu/AccountSettings"));

function Sidebar() {
  const basePath = useMemo(() => new URL(baseUrl).pathname, []);

  const isRootMatch = useMatch("/");
  const isBasePathMatch = useMatch(basePath);

  const navbarLinks = useNavigation();
  // Non-suspending: suspending here held back the whole sidebar (and its lazy
  // Settings and Account menus) until the fork namespace loaded
  const { t } = useTranslation(["fork"], { useSuspense: false });

  return (
    <aside
      data-fork-rail={isForkEnabled("themeControls") || undefined}
      className="scrollbar-container scrollbar-hidden absolute inset-y-0 left-0 z-10 flex w-[52px] flex-col justify-between overflow-y-auto border-r border-secondary-highlight bg-background_alt py-4"
    >
      <div className="flex w-full flex-col items-center gap-0">
        <Link to="/" aria-label={t("a11y.home")}>
          <Logo className="mb-6 h-8 w-8" />
        </Link>
        {navbarLinks.map((item) => {
          const showCameraGroups =
            (isRootMatch || isBasePathMatch) && item.id === 1;

          return (
            <div key={item.id}>
              {/* fork (UI134): the magnifier opens the search box, which
                  covers pages, cameras, settings and footage, instead of
                  jumping straight to Explore */}
              {isRailSearchItem(item.id) ? (
                <NavSearchButton className="mx-[10px] mb-4" />
              ) : (
                <NavItem
                  className={`mx-[10px] ${showCameraGroups ? "mb-2" : "mb-4"}`}
                  item={item}
                  Icon={item.icon}
                />
              )}
              {showCameraGroups && (
                <Suspense fallback={<div className="mb-4 size-6" />}>
                  <CameraGroupSelector className="mb-4" />
                </Suspense>
              )}
            </div>
          );
        })}
      </div>
      <div className="mb-8 flex flex-col items-center gap-4">
        <ForkNavItems variant="sidebar" />
        <Suspense fallback={<div className="size-8" />}>
          <GeneralSettings />
        </Suspense>
        <Suspense fallback={<div className="size-8" />}>
          <AccountSettings />
        </Suspense>
      </div>
    </aside>
  );
}

export default Sidebar;
