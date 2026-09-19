/**
 * Fork (UI110): the status bar's warnings as one chip.
 *
 * The bar used to print every warning as a full sentence, so a single long
 * one ("Host collector is missing or stale...") filled the bar and several
 * scrolled sideways. The bar now shows a small chip with the count; it opens
 * a popover listing each message with a link to the page that explains it.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IoIosWarning } from "react-icons/io";
import { LuChevronRight } from "react-icons/lu";
import { Link } from "react-router-dom";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type {
  StatusMessage,
  StatusMessagesState,
} from "@/context/statusbar-context";
import { cn } from "@/lib/utils";

type StatusIssuesChipProps = {
  messages: StatusMessagesState;
};

export default function StatusIssuesChip({
  messages,
}: Readonly<StatusIssuesChipProps>) {
  const { t } = useTranslation(["fork"]);
  const [open, setOpen] = useState(false);

  const issues = useMemo<StatusMessage[]>(
    () => Object.values(messages).flat(),
    [messages],
  );
  // a message without a color has always been drawn as an error
  const severe = issues.some(
    (issue) => !issue.color || issue.color === "text-danger",
  );

  if (issues.length === 0) {
    return null;
  }

  return (
    // the bar stays in place across pages, so back closes the list here
    // instead of leaving it open over the previous page
    <Popover open={open} onOpenChange={setOpen} enableHistoryBack>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="status-issues-chip"
          aria-label={t("statusAlerts.chipLabel", { count: issues.length })}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            severe
              ? "border-red-500/50 bg-red-50 text-red-800 hover:bg-red-100 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50"
              : "border-amber-500/50 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50",
          )}
        >
          <IoIosWarning className="size-4 shrink-0" aria-hidden />
          {t("statusAlerts.count", { count: issues.length })}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        data-testid="status-issues-list"
        className="w-[min(24rem,calc(100vw-2rem))] p-0"
      >
        <div className="border-b border-border px-3 py-2 text-sm font-medium">
          {t("statusAlerts.label")}
        </div>
        <ul className="max-h-[60dvh] divide-y divide-border overflow-y-auto">
          {issues.map(({ id, text, color, link }) => (
            <li key={id} className="flex items-start gap-2 px-3 py-2.5">
              <IoIosWarning
                className={cn("mt-0.5 size-4 shrink-0", color || "text-danger")}
                aria-hidden
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-sm text-primary">{text}</p>
                {link && (
                  <Link
                    to={link}
                    className="flex w-fit items-center gap-0.5 text-xs text-primary-variant hover:underline"
                    onClick={() => setOpen(false)}
                  >
                    {t("statusAlerts.open")}
                    <LuChevronRight className="size-3" aria-hidden />
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
