/**
 * Fork (E26): signed-in sessions with their revoke actions.
 *
 * Without `user` it lists every session the server returns (all users', for
 * an admin) grouped by user, each group with "Sign out everywhere", or
 * "Sign out other sessions" for the caller's own group. With `user` it lists
 * only that user's sessions, for the account menu's dialog.
 *
 * A group shows its first few sessions (this device first) and folds the
 * rest behind "Show N more": scripts that sign in on every run leave one
 * session per run, and a real install listed close to 200 for admin.
 *
 * When every session comes from one private address, the settings list
 * says why once (a proxy or Docker's network) and how to see real ones.
 */

import { useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCircleCheck, LuExternalLink } from "react-icons/lu";
import { toast } from "sonner";
import ConfirmClearDialog from "@/components/fork/settings/ConfirmClearDialog";
import { Button } from "@/components/ui/button";
import { AuthContext } from "@/context/auth-state";
import {
  type SessionItem,
  useSessions,
  useSessionText,
} from "@/hooks/fork/use-sessions";
import { useDocDomain } from "@/hooks/use-doc-domain";
import {
  groupSessionsByUser,
  otherSessions,
  sharedProxyAddress,
  type SessionGroup,
} from "@/lib/fork/sessions";
import SessionRow from "./SessionRow";

/** Sessions a group shows before folding the rest away. */
export const VISIBLE_SESSIONS = 5;

type Pending =
  | { kind: "one"; session: SessionItem; name: string }
  | { kind: "everywhere"; username: string }
  | { kind: "others"; username: string; count: number };

/**
 * The group's bulk action: the caller's own group signs out the other
 * sessions (none when there are none), anyone else's signs out everywhere.
 */
function groupAction(
  group: SessionGroup<SessionItem>,
  own: boolean,
): Pending | null {
  if (!own) {
    return { kind: "everywhere", username: group.username };
  }
  const count = otherSessions(group.sessions).length;
  return count > 0 ? { kind: "others", username: group.username, count } : null;
}

type SessionsPanelProps = {
  /** List only this user's sessions, without group headers. */
  user?: string;
  /**
   * Where results are reported: as toasts, or inside the panel for the
   * account menu's dialog. The menu opens on any page, and a page's Toaster
   * sits under the dialog's overlay (the live dashboard) or is not there.
   */
  feedbackStyle?: "toast" | "inline";
};

type Feedback = { tone: "success" | "error"; text: string };

export default function SessionsPanel({
  user,
  feedbackStyle = "toast",
}: Readonly<SessionsPanelProps>) {
  const { t } = useTranslation(["fork"]);
  const { auth } = useContext(AuthContext);
  const me = user ?? auth.user?.username;
  const sessions = useSessions(true);
  const { data, isLoading, mutate, revoke, revokeAll } = sessions;
  const { describe } = useSessionText();
  const { getLocaleDocUrl } = useDocDomain();
  // kept after the confirmation closes, so its text stays while it fades
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // users whose whole list is unfolded
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const failed = sessions.error !== undefined;

  const notify = (tone: Feedback["tone"], text: string) => {
    if (feedbackStyle === "inline") {
      setFeedback({ tone, text });
    } else if (tone === "success") {
      toast.success(text);
    } else {
      toast.error(text);
    }
  };

  const toggleFold = useCallback((username: string) => {
    setUnfolded((current) => {
      const next = new Set(current);
      if (!next.delete(username)) {
        next.add(username);
      }
      return next;
    });
  }, []);

  const shown = useMemo(() => {
    const listed = data ?? [];
    return user === undefined
      ? listed
      : listed.filter((session) => session.username === user);
  }, [data, user]);
  const groups = useMemo(() => groupSessionsByUser(shown, me), [shown, me]);
  const proxyAddress = useMemo(() => sharedProxyAddress(shown), [shown]);

  const run = async (action: Pending) => {
    setFeedback(null);
    if (action.kind === "one") {
      setBusy(action.session.id);
      try {
        await revoke(action.session.id);
        notify("success", t("sessions.revoked"));
      } catch {
        notify("error", t("sessions.revokeFailed"));
      } finally {
        setBusy(null);
      }
      return;
    }

    setBusy(`user:${action.username}`);
    try {
      const revoked = await revokeAll(
        action.username,
        action.kind === "others",
      );
      notify(
        "success",
        revoked === 0
          ? t("sessions.signedOutNone")
          : t("sessions.signedOut", { count: revoked }),
      );
    } catch {
      notify("error", t("sessions.signOutFailed"));
    } finally {
      setBusy(null);
    }
  };

  const confirmText = (action: Pending) => {
    switch (action.kind) {
      case "one":
        return {
          title: t("sessions.revokeTitle"),
          description: t("sessions.revokeDescription", {
            device: action.name,
            user: action.session.username,
          }),
          action: t("sessions.revoke"),
        };
      case "everywhere":
        return {
          title: t("sessions.everywhereTitle", { user: action.username }),
          description: t("sessions.everywhereDescription", {
            user: action.username,
          }),
          action: t("sessions.signOutEverywhere"),
        };
      case "others":
        return {
          title: t("sessions.othersTitle"),
          description: t("sessions.othersDescription", {
            count: action.count,
          }),
          action: t("sessions.signOutOthers"),
        };
    }
  };

  const ask = (action: Pending) => {
    setPending(action);
    setConfirmOpen(true);
  };

  const now = Date.now() / 1000;
  const confirm = pending === null ? null : confirmText(pending);

  return (
    <div className="flex flex-col gap-3" data-testid="sessions-panel">
      {feedback?.tone === "success" && (
        <output
          className="flex items-center gap-2 text-sm"
          data-testid="sessions-feedback"
        >
          <LuCircleCheck className="size-4 shrink-0 text-success" aria-hidden />
          {feedback.text}
        </output>
      )}
      {feedback?.tone === "error" && (
        <p
          className="text-sm text-danger"
          role="alert"
          data-testid="sessions-feedback"
        >
          {feedback.text}
        </p>
      )}
      {isLoading && (
        <output className="block text-sm text-muted-foreground">
          {t("sessions.loading")}
        </output>
      )}
      {failed && !isLoading && data === undefined && (
        <div className="flex items-center justify-between gap-2" role="alert">
          <p className="text-sm text-danger">{t("sessions.loadFailed")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="focus-visible:ring-selected"
            onClick={() => {
              void mutate(); // the list shows the outcome
            }}
          >
            {t("sessions.retry")}
          </Button>
        </div>
      )}
      {user === undefined && proxyAddress !== null && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="sessions-proxy-hint"
        >
          {t("sessions.proxyHint", { ip: proxyAddress })}{" "}
          <a
            href={getLocaleDocUrl(
              "configuration/authentication#login-failure-rate-limiting",
            )}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-primary"
          >
            {t("readTheDocumentation", { ns: "common" })}
            <LuExternalLink className="ml-1 size-3" aria-hidden />
          </a>
        </p>
      )}
      {data !== undefined && groups.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {user === undefined ? t("sessions.empty") : t("sessions.emptyMine")}
        </p>
      )}
      {groups.map((group) => {
        const own = group.username === me;
        const action = groupAction(group, own);
        let actionLabel = own
          ? t("sessions.signOutOthers")
          : t("sessions.signOutEverywhere");
        if (busy === `user:${group.username}`) {
          actionLabel = t("sessions.signingOut");
        }

        const actionButton = action && (
          <Button
            type="button"
            variant={own ? "outline" : "destructive"}
            size="sm"
            // a visible focus ring (the theme's --ring draws nothing)
            className="shrink-0 focus-visible:ring-selected"
            disabled={busy !== null}
            aria-label={
              own
                ? t("sessions.signOutOthers")
                : t("sessions.signOutEverywhereLabel", {
                    user: group.username,
                  })
            }
            onClick={() => ask(action)}
          >
            {actionLabel}
          </Button>
        );

        const open = unfolded.has(group.username);
        const visible = open
          ? group.sessions
          : group.sessions.slice(0, VISIBLE_SESSIONS);
        const folded = group.sessions.length - VISIBLE_SESSIONS;
        const foldButton = folded > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start focus-visible:ring-selected"
            aria-expanded={open}
            onClick={() => toggleFold(group.username)}
          >
            {open
              ? t("sessions.showFewer")
              : t("sessions.showMore", { count: folded })}
          </Button>
        );

        const rows = (
          <ul className="flex flex-col divide-y divide-border">
            {visible.map((session) => {
              const text = describe(session, now);
              return (
                <SessionRow
                  key={session.id}
                  session={session}
                  text={text}
                  disabled={busy !== null}
                  revoking={busy === session.id}
                  proxied={session.ip === proxyAddress}
                  onRevoke={(target) =>
                    ask({ kind: "one", session: target, name: text.name })
                  }
                />
              );
            })}
          </ul>
        );

        if (user !== undefined) {
          return (
            <div key={group.username} className="flex flex-col gap-3">
              {rows}
              {foldButton}
              {actionButton && (
                <div className="flex justify-end">{actionButton}</div>
              )}
            </div>
          );
        }

        return (
          <section
            key={group.username}
            className="rounded-lg border border-border bg-background_alt px-3 py-2"
            aria-label={t("sessions.groupLabel", { user: group.username })}
            data-testid="session-group"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
              <div className="min-w-0">
                <span className="text-sm font-semibold">{group.username}</span>
                {own && (
                  <span className="ml-1 text-sm text-muted-foreground">
                    {t("sessions.you")}
                  </span>
                )}
                <span className="ml-2 text-xs text-muted-foreground">
                  {t("sessions.count", { count: group.sessions.length })}
                </span>
              </div>
              {actionButton}
            </div>
            {rows}
            {foldButton && (
              <div className="border-t border-border pt-2">{foldButton}</div>
            )}
          </section>
        );
      })}
      <ConfirmClearDialog
        title={confirm?.title ?? ""}
        description={confirm?.description ?? ""}
        action={confirm?.action ?? ""}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {
          if (pending !== null) {
            void run(pending); // the outcome is reported inside
          }
        }}
      />
    </div>
  );
}
