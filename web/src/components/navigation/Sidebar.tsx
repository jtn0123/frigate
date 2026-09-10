import Logo from "../Logo";
import NavItem from "./NavItem";
import { Link, useMatch } from "react-router-dom";
import useNavigation from "@/hooks/use-navigation";
import { baseUrl } from "@/api/baseUrl";
import { Suspense, lazy, useMemo } from "react";
import ForkNavItems from "@/components/fork/ForkNavItems";

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

  return (
    <aside className="scrollbar-container scrollbar-hidden absolute inset-y-0 left-0 z-10 flex w-[52px] flex-col justify-between overflow-y-auto border-r border-secondary-highlight bg-background_alt py-4">
      <span tabIndex={0} className="sr-only" />
      <div className="flex w-full flex-col items-center gap-0">
        <Link to="/">
          <Logo className="mb-6 h-8 w-8" />
        </Link>
        {navbarLinks.map((item) => {
          const showCameraGroups =
            (isRootMatch || isBasePathMatch) && item.id === 1;

          return (
            <div key={item.id}>
              <NavItem
                className={`mx-[10px] ${showCameraGroups ? "mb-2" : "mb-4"}`}
                item={item}
                Icon={item.icon}
              />
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
