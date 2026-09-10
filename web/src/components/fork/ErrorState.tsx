/**
 * Fork: inline error state for read-path failures (report item C5).
 *
 * Views that fetch with SWR historically rendered nothing (or a spinner
 * forever) when the request failed. Drop this in where the `error` from
 * `useSWR` is truthy to show an icon, a translated message and, when a
 * `mutate` is available, a retry button.
 */

import { useTranslation } from "react-i18next";
import { LuCloudOff, LuRefreshCw } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import Heading from "@/components/ui/heading";
import { cn } from "@/lib/utils";

type ErrorStateProps = {
  /** The error returned by useSWR (axios error, Error, or anything). */
  error?: unknown;
  /** Overrides the default "Could not load this data" title. */
  title?: string;
  /** Extra context shown under the title (defaults to the server message). */
  description?: string;
  /** Called by the retry button; the button is hidden when omitted. */
  onRetry?: () => void;
  /** Smaller layout for use inside a toolbar or strip. */
  compact?: boolean;
  className?: string;
};

// eslint-disable-next-line react-refresh/only-export-components
export function describeError(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }
  const err = error as {
    response?: { status?: number; data?: { message?: unknown } };
    message?: unknown;
  };
  const serverMessage = err.response?.data?.message;
  if (typeof serverMessage === "string" && serverMessage.trim()) {
    return serverMessage;
  }
  if (err.response?.status) {
    return `HTTP ${err.response.status}`;
  }
  if (typeof err.message === "string" && err.message.trim()) {
    return err.message;
  }
  return undefined;
}

export default function ErrorState({
  error,
  title,
  description,
  onRetry,
  compact = false,
  className,
}: ErrorStateProps) {
  const { t } = useTranslation(["fork"]);
  const detail = description ?? describeError(error);

  if (compact) {
    return (
      <div
        role="alert"
        data-testid="fork-error-state"
        className={cn(
          "flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm text-primary",
          className,
        )}
      >
        <LuCloudOff className="size-4 shrink-0 text-danger" />
        <span className="truncate">{title ?? t("errorState.title")}</span>
        {detail && (
          <span className="truncate text-secondary-foreground">{detail}</span>
        )}
        {onRetry && (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto size-auto px-2 py-0.5"
            aria-label={t("errorState.retry")}
            onClick={onRetry}
          >
            <LuRefreshCw className="mr-1 size-3" />
            {t("errorState.retry")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="fork-error-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 p-4 text-center",
        className,
      )}
    >
      <LuCloudOff className="size-10 text-danger" />
      <Heading as="h4">{title ?? t("errorState.title")}</Heading>
      <p className="max-w-md text-sm text-secondary-foreground">
        {t("errorState.description")}
      </p>
      {detail && (
        <code className="max-w-full break-words rounded-md bg-secondary px-2 py-1 text-xs text-primary">
          {detail}
        </code>
      )}
      {onRetry && (
        <Button
          size="sm"
          variant="select"
          className="mt-1"
          aria-label={t("errorState.retry")}
          onClick={onRetry}
        >
          <LuRefreshCw className="mr-2 size-4" />
          {t("errorState.retry")}
        </Button>
      )}
    </div>
  );
}
