/**
 * Tracked-object detail header for phones (fork, flag `phoneFixes`).
 *
 * On a phone the Explore detail fills the screen. Upstream's header sets the
 * title and the event summary side by side, so the title wraps to three
 * lines behind the back button, and there is no previous/next (the desktop
 * arrows sit outside the dialog). This header keeps the title on one line
 * with previous/next as a segmented control on the right, and gives the
 * summary and share button a full-width row underneath.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FaChevronLeft, FaChevronRight } from "react-icons/fa";
import {
  MobilePageDescription,
  MobilePageHeader,
  MobilePageTitle,
} from "@/components/mobile/MobilePage";
import { Button } from "@/components/ui/button";

type PhoneDetailHeaderProps = {
  title: string;
  onPrevious?: () => void;
  onNext?: () => void;
  children: ReactNode;
};

export default function PhoneDetailHeader({
  title,
  onPrevious,
  onNext,
  children,
}: Readonly<PhoneDetailHeaderProps>) {
  const { t } = useTranslation(["views/explore"]);

  const nav =
    onPrevious && onNext ? (
      <div
        className="flex items-center overflow-hidden rounded-lg bg-secondary"
        data-testid="phone-detail-nav"
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-10 rounded-none p-0"
          aria-label={t("searchResult.previousTrackedObject")}
          onClick={onPrevious}
        >
          <FaChevronLeft className="size-3.5 text-secondary-foreground" />
        </Button>
        <div aria-hidden="true" className="h-5 w-px bg-border" />
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-10 rounded-none p-0"
          aria-label={t("searchResult.nextTrackedObject")}
          onClick={onNext}
        >
          <FaChevronRight className="size-3.5 text-secondary-foreground" />
        </Button>
      </div>
    ) : undefined;

  return (
    <>
      <MobilePageHeader className="top-0 z-[60] mb-0" actions={nav}>
        <MobilePageTitle className="whitespace-nowrap">{title}</MobilePageTitle>
        <MobilePageDescription className="sr-only">
          {title}
        </MobilePageDescription>
      </MobilePageHeader>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border/60 pb-3">
        {children}
      </div>
    </>
  );
}
