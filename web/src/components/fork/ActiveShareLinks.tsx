/**
 * Fork: the signed-in user's unexpired clip share links, each revocable (E16).
 *
 * An admin gets every user's links from the server, so a link made by
 * someone else names its creator.
 */

import { useCallback, useContext, useState } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useApi } from "@/api/fork/client";
import { Button } from "@/components/ui/button";
import { AuthContext } from "@/context/auth-state";
import { shareExpiry, type ShareExpiry } from "@/lib/fork/share-path";
import type { components } from "@/types/fork/api.gen";

type ShareLink = components["schemas"]["ShareLinkListItem"];

type ActiveShareLinksProps = {
  /** Token of the link the dialog just made, marked in the list. */
  currentToken?: string | undefined;
  /** Called after a link is revoked, with its token. */
  onRevoked?: (token: string) => void;
};

export default function ActiveShareLinks({
  currentToken,
  onRevoked,
}: Readonly<ActiveShareLinksProps>) {
  const { t } = useTranslation(["fork"]);
  const { auth } = useContext(AuthContext);
  const links = useApi("/fork/share", { revalidateOnFocus: false });
  const { data, isLoading, mutate } = links;
  const failed = links.error !== undefined;
  const [revoking, setRevoking] = useState<string | null>(null);

  const revoke = useCallback(
    async (link: ShareLink) => {
      setRevoking(link.token);
      let gone = false;
      try {
        await axios.delete(`fork/share/${link.token}`);
      } catch (error) {
        // 404: the link expired or was revoked elsewhere, which is the outcome
        // the user asked for
        gone = axios.isAxiosError(error) && error.response?.status === 404;
        if (!gone) {
          toast.error(t("clipShare.revokeFailed"));
          // the list may be what is out of date, so read it again
          void mutate();
          return;
        }
      } finally {
        setRevoking(null);
      }
      if (!gone) {
        toast.success(t("clipShare.revoked"));
      }
      onRevoked?.(link.token);
      await mutate(
        (links) => links?.filter((item) => item.token !== link.token),
        { revalidate: true },
      );
    },
    [mutate, onRevoked, t],
  );

  // One literal key per unit, in the scope of useTranslation, so the i18n
  // extractor finds the plural forms in the fork namespace.
  const expiryText = (expiry: ShareExpiry) => {
    switch (expiry.unit) {
      case "minutes":
        return t("clipShare.expiresIn.minutes", { count: expiry.count });
      case "hours":
        return t("clipShare.expiresIn.hours", { count: expiry.count });
      case "days":
        return t("clipShare.expiresIn.days", { count: expiry.count });
    }
  };

  const now = Date.now() / 1000;

  return (
    <section
      className="flex flex-col gap-2 border-t pt-3"
      aria-labelledby="share-clip-active-heading"
      data-testid="share-clip-active"
    >
      <h3 id="share-clip-active-heading" className="text-sm font-medium">
        {t("clipShare.activeTitle")}
      </h3>
      {isLoading && (
        <p className="text-sm text-muted-foreground" role="status">
          {t("clipShare.activeLoading")}
        </p>
      )}
      {failed && !isLoading && (
        <div className="flex items-center justify-between gap-2" role="alert">
          <p className="text-sm text-danger">{t("clipShare.activeFailed")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void mutate(); // the list shows the outcome
            }}
          >
            {t("clipShare.retry")}
          </Button>
        </div>
      )}
      {data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("clipShare.activeEmpty")}
        </p>
      )}
      {data !== undefined && data.length > 0 && (
        <ul className="scrollbar-container flex max-h-40 flex-col gap-1 overflow-y-auto">
          {data.map((link) => {
            const expires = expiryText(shareExpiry(link.expires_at, now));
            const name = t("clipShare.linkName", {
              camera: link.camera.replaceAll("_", " "),
              event: link.event_id,
            });
            return (
              <li
                key={link.token}
                className="flex items-center justify-between gap-2 text-sm"
                data-testid="share-clip-active-row"
              >
                <div className="min-w-0">
                  <p className="truncate smart-capitalize">
                    {name}
                    {link.token === currentToken && (
                      <span className="ml-1 text-muted-foreground">
                        {t("clipShare.thisLink")}
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {expires}
                    {auth.user !== null &&
                      link.created_by !== auth.user.username &&
                      ` · ${t("clipShare.createdBy", { user: link.created_by })}`}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={revoking !== null}
                  aria-label={t("clipShare.revokeLabel", { name })}
                  onClick={() => {
                    void revoke(link); // failures are toasted inside
                  }}
                >
                  {revoking === link.token
                    ? t("clipShare.revoking")
                    : t("clipShare.revoke")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
