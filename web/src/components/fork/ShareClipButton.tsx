/**
 * Fork: create an expiring clip share link with a QR code (UI11).
 */

import { useCallback, useState } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { LuShare2 } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { wrapAsync } from "@/utils/promise";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isForkEnabled } from "@/fork/flags";
import { qrSvg } from "@/lib/fork/qr";
import { sharePageUrl } from "@/lib/fork/share-path";
import { toast } from "sonner";

type ShareResponse = {
  token: string;
  url: string;
  expires_at: number;
};

type ShareClipButtonProps = {
  eventId?: string | null;
  hasClip?: boolean;
};

export default function ShareClipButton({
  eventId,
  hasClip = true,
}: ShareClipButtonProps) {
  const { t } = useTranslation(["fork"]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [share, setShare] = useState<ShareResponse | null>(null);

  const createShare = useCallback(async () => {
    if (!eventId) {
      return;
    }
    setLoading(true);
    try {
      const response = await axios.post<ShareResponse>("fork/share", {
        event_id: eventId,
      });
      setShare(response.data);
    } catch {
      toast.error(t("clipShare.createFailed"));
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }, [eventId, t]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        void createShare();
      } else {
        setShare(null);
      }
    },
    [createShare],
  );

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
          {loading && !share ? (
            <p className="text-sm text-muted-foreground">
              {t("clipShare.creating")}
            </p>
          ) : share ? (
            <div className="flex flex-col gap-3">
              <div
                className="mx-auto size-44 rounded-md bg-white p-2"
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
                <Button type="button" onClick={wrapAsync(copyLink)}>
                  {t("clipShare.copy")}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
