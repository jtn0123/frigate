/**
 * The Spotlights entry in the Settings menu (fork, UI144).
 *
 * The rail carries Spotlights on a wide screen. The phone bar has no free
 * slot (another icon would shrink every target below 48 px), so wherever the
 * rail is not shown the Settings menu, the phone's overflow menu, leads
 * there, at the top where it is one tap from the bar.
 */

import { isDesktop as uaIsDesktop } from "react-device-detect";
import { useTranslation } from "react-i18next";
import { LuFlashlight } from "react-icons/lu";
import { Link } from "react-router-dom";
import { DialogClose } from "@/components/ui/dialog";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { isForkEnabled } from "@/fork/flags";
import { useIsDesktop } from "@/hooks/fork/use-viewport";
import { SPOTLIGHTS_PATH } from "@/lib/fork/spotlights-nav";

export default function SpotlightsMenuItem() {
  const { t } = useTranslation(["fork"]);
  const railShown = useIsDesktop();

  if (railShown || !isForkEnabled("spotlights")) {
    return null;
  }

  // the menu is a dropdown or a drawer by user agent, as in GeneralSettings
  const Item = uaIsDesktop ? DropdownMenuItem : DialogClose;
  return (
    <>
      <Item asChild>
        <Link
          to={SPOTLIGHTS_PATH}
          data-testid="spotlights-menu-item"
          className={
            uaIsDesktop
              ? "cursor-pointer"
              : "flex w-full items-center p-2 text-sm"
          }
        >
          <LuFlashlight className="mr-2 size-4" aria-hidden />
          <span>{t("spotlights.title")}</span>
        </Link>
      </Item>
      <DropdownMenuSeparator className={uaIsDesktop ? "mt-1" : "my-1"} />
    </>
  );
}
