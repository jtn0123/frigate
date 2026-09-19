/**
 * Fork: error state for the Users and Roles settings pages (UI103).
 *
 * The page waited for `/api/users` with a spinner and never left it when the
 * read failed. This names the failure instead: a 403 means the signed-in
 * account is not an admin, anything else is the generic "no valid response"
 * case with the server's message. Retry refetches through SWR's `mutate`.
 */

import { useTranslation } from "react-i18next";
import ErrorState from "@/components/fork/ErrorState";

type UsersLoadErrorProps = {
  error: unknown;
  onRetry: () => void;
};

function statusOf(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response
    ?.status;
  return typeof status === "number" ? status : undefined;
}

export default function UsersLoadError({
  error,
  onRetry,
}: Readonly<UsersLoadErrorProps>) {
  const { t } = useTranslation(["fork"]);
  const status = statusOf(error);
  const forbidden = status === 401 || status === 403;
  // the 403 sentence already names the status, so it drops the detail
  const forbiddenText = forbidden
    ? { message: t("usersLoadError.forbidden", { status }), description: "" }
    : {};

  return (
    <div className="flex size-full items-center justify-center">
      <ErrorState
        error={error}
        title={t("usersLoadError.title")}
        {...forbiddenText}
        onRetry={onRetry}
        className="max-w-lg"
      />
    </div>
  );
}
