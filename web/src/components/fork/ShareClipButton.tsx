/**
 * Fork: create an expiring clip share link with a QR code (UI11).
 *
 * Opening the dialog only lists the active links. A link is made by the
 * "Create link" button, so looking at the list (or revoking from it at the
 * 50 link cap) never mints another public link.
 */

import { useCallback, useRef, useState } from "react";
import axios from "axios";
import { useSWRConfig } from "swr";
import { useTranslation } from "react-i18next";
import { LuShare2 } from "react-icons/lu";
import { swrKey } from "@/api/fork/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import ActiveShareLinks from "@/components/fork/ActiveShareLinks";
import { isForkEnabled } from "@/fork/flags";
import { qrSvg } from "@/lib/fork/qr";
import { sharePageUrl } from "@/lib/fork/share-path";
import type { components } from "@/types/fork/api.gen";
import { toast } from "sonner";

type ShareResponse = components["schemas"]["ShareLinkResponse"];
type CreateError = "limit" | "failed";

type ShareClipButtonProps = {
  eventId?: string | null;
  hasClip?: boolean;
};

export default function ShareClipButton({
  eventId,
  hasClip = true,
}: Readonly<ShareClipButtonProps>) {
  const { t } = useTranslation(["fork"]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [share, setShare] = useState<ShareResponse | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [createError, setCreateError] = useState<CreateError | null>(null);
  // Bumped by every create and every close; a response whose id is no longer
  // the latest belongs to a dialog the user has left and is dropped.
  const requestRef = useRef(0);
  const { mutate } = useSWRConfig();

  const createShare = useCallback(async () => {
    if (!eventId) {
      return;
    }
    requestRef.current += 1;
    const request = requestRef.current;
    setLoading(true);
    setCreateError(null);
    let created: ShareResponse | null = null;
    let failure: CreateError | null = null;
    try {
      const response = await axios.post<ShareResponse>("fork/share", {
        event_id: eventId,
      });
      created = response.data;
    } catch (error) {
      failure =
        axios.isAxiosError(error) && error.response?.status === 429
          ? "limit"
          : "failed";
    }
    if (created) {
      // the link exists even when its dialog is gone, so the list is stale
      void mutate(swrKey("/fork/share"));
    }
    if (request !== requestRef.current) {
      return;
    }
    // The dialog stays open on a failure: at the link cap the list below is
    // the only place to revoke a link and make room.
    setLoading(false);
    setShare(created);
    setRevoked(false);
    setCreateError(failure);
  }, [eventId, mutate]);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      requestRef.current += 1;
      setLoading(false);
      setShare(null);
      setRevoked(false);
      setCreateError(null);
    }
  }, []);

  const copyLink = useCallback(async () => {
    if (!share) {
      return;
    }
    try {
      await navigator.clipboard.writeText(sharePageUrl(share.token));
      toast.success(t("clipShare.copied"));
    } catch {
      toast.error(t("clipShare.copyFailed"));
    }
  }, [share, t]);

  const onRevoked = useCallback(
    (token: string) => {
      if (token === share?.token) {
        setRevoked(true);
      }
      // a revoked link makes room under the cap
      setCreateError((current) => (current === "limit" ? null : current));
    },
    [share],
  );

  if (!isForkEnabled("clipSharing") || !hasClip || !eventId) {
    return null;
  }

  const absoluteUrl = share ? sharePageUrl(share.token) : "";

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="share-clip"
        aria-label={t("clipShare.action")}
        onClick={() => handleOpenChange(true)}
      >
        <LuShare2 className="mr-1.5 size-4" />
        {t("clipShare.action")}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent data-testid="share-clip-dialog">
          <DialogHeader>
            <DialogTitle>{t("clipShare.title")}</DialogTitle>
            <DialogDescription>{t("clipShare.description")}</DialogDescription>
          </DialogHeader>
          {createError && (
            <p
              className="text-sm text-danger"
              role="alert"
              data-testid="share-clip-error"
            >
              {createError === "limit"
                ? t("clipShare.limitReached")
                : t("clipShare.createFailed")}
            </p>
          )}
          {(!share || revoked) && (
            <Button
              type="button"
              variant="select"
              disabled={loading}
              data-testid="share-clip-create"
              onClick={() => {
                void createShare(); // the outcome is shown in the dialog
              }}
            >
              {loading ? t("clipShare.creating") : t("clipShare.create")}
            </Button>
          )}
          {share && revoked && (
            <p className="text-sm text-muted-foreground" role="status">
              {t("clipShare.revokedNotice")}
            </p>
          )}
          {share && !revoked && (
            <div className="flex flex-col gap-3">
              <div
                className="mx-auto size-44 rounded-md bg-white p-2"
                role="img"
                aria-label={t("clipShare.qr")}
                data-testid="share-clip-qr"
                dangerouslySetInnerHTML={{ __html: qrSvg(absoluteUrl) }}
              />
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={absoluteUrl}
                  aria-label={t("clipShare.link")}
                  data-testid="share-clip-url"
                />
                <Button
                  type="button"
                  onClick={() => {
                    void copyLink(); // clipboard write is fire-and-forget
                  }}
                >
                  {t("clipShare.copy")}
                </Button>
              </div>
            </div>
          )}
          {open && (
            <ActiveShareLinks
              currentToken={revoked ? undefined : share?.token}
              onRevoked={onRevoked}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
