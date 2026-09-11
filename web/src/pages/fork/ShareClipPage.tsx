/**
 * Public page for an expiring clip share link (UI11).
 *
 * Lives outside ProtectedRoute so a recipient does not need a Frigate
 * login. The token is the credential.
 */

import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { qrSvg } from "@/lib/fork/qr";
import { sharePageUrl } from "@/lib/fork/share-path";
import { baseUrl } from "@/api/baseUrl";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import Heading from "@/components/ui/heading";

type ShareInfo = {
  token: string;
  camera: string;
  label: string;
  expires_at: number;
  has_clip: boolean;
};

export default function ShareClipPage() {
  const { t } = useTranslation(["fork"]);
  const { token = "" } = useParams<{ token: string }>();
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ok" | "expired" | "missing"
  >("loading");

  useEffect(() => {
    document.title = t("clipShare.pageTitle");
  }, [t]);

  useEffect(() => {
    if (!token) {
      setStatus("missing");
      return;
    }
    let cancelled = false;
    axios
      .get<ShareInfo>(`fork/share/${token}`)
      .then((response) => {
        if (!cancelled) {
          setShare(response.data);
          setStatus("ok");
        }
      })
      .catch((error: { response?: { status?: number } }) => {
        if (cancelled) {
          return;
        }
        setStatus(error.response?.status === 410 ? "expired" : "missing");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const absoluteUrl = useMemo(
    () => (token ? sharePageUrl(token) : ""),
    [token],
  );

  return (
    <div
      id="pageRoot"
      className="flex size-full items-center justify-center overflow-auto p-4"
      data-testid="share-clip-page"
    >
      <div className="flex w-full max-w-lg flex-col gap-4">
        <Heading as="h2">{t("clipShare.pageTitle")}</Heading>
        {status === "loading" && <ActivityIndicator />}
        {status === "missing" && (
          <p className="text-sm text-secondary-foreground">
            {t("clipShare.missing")}
          </p>
        )}
        {status === "expired" && (
          <p className="text-sm text-secondary-foreground">
            {t("clipShare.expired")}
          </p>
        )}
        {status === "ok" && share && (
          <>
            <p className="text-sm text-secondary-foreground smart-capitalize">
              {share.label} · {share.camera}
            </p>
            {share.has_clip ? (
              // Shared clips have no caption track; this is a silent NVR recording.
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                className="w-full rounded-md bg-black"
                controls
                playsInline
                src={`${baseUrl}api/fork/share/${token}/clip.mp4`}
                aria-label={t("clipShare.play")}
              />
            ) : (
              <p className="text-sm text-secondary-foreground">
                {t("clipShare.noClip")}
              </p>
            )}
            <div
              className="mx-auto size-44 rounded-md bg-white p-2"
              aria-label={t("clipShare.qr")}
              data-testid="share-clip-qr"
              dangerouslySetInnerHTML={{ __html: qrSvg(absoluteUrl) }}
            />
          </>
        )}
      </div>
    </div>
  );
}
