/**
 * Public page for an expiring clip share link (UI11).
 *
 * Lives outside ProtectedRoute so a recipient does not need a Frigate
 * login. The token is the credential.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { qrSvg } from "@/lib/fork/qr";
import {
  isShareToken,
  shareCameraName,
  sharePageUrl,
} from "@/lib/fork/share-path";
import { baseUrl } from "@/api/baseUrl";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { Button } from "@/components/ui/button";
import Heading from "@/components/ui/heading";
import type { components } from "@/types/fork/api.gen";

type ShareInfo = components["schemas"]["ShareLinkResponse"];

/**
 * "missing" and "expired" are the server's final answers (404, 410). "error"
 * is everything that may pass (no network, 5xx, 429), so it offers a retry.
 */
type ShareStatus = "loading" | "ok" | "expired" | "missing" | "error";

function failureStatus(httpStatus: number | undefined): ShareStatus {
  if (httpStatus === 404) {
    return "missing";
  }
  if (httpStatus === 410) {
    return "expired";
  }
  return "error";
}

export default function ShareClipPage() {
  const { t } = useTranslation(["fork"]);
  const { token = "" } = useParams<{ token: string }>();
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [status, setStatus] = useState<ShareStatus>("loading");
  const [videoFailed, setVideoFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    document.title = t("clipShare.pageTitle");
  }, [t]);

  useEffect(() => {
    // never put anything but a well-formed token into a request path
    if (!isShareToken(token)) {
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
        setStatus(failureStatus(error.response?.status));
      });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  // Reads the link again, which also tells an expired link (410) apart from a
  // clip that failed to play for a passing reason.
  const retry = useCallback(() => {
    setVideoFailed(false);
    setShare(null);
    setStatus("loading");
    setAttempt((current) => current + 1);
  }, []);

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
          <p className="text-sm text-secondary-foreground" role="status">
            {t("clipShare.missing")}
          </p>
        )}
        {status === "expired" && (
          <p className="text-sm text-secondary-foreground" role="status">
            {t("clipShare.expired")}
          </p>
        )}
        {status === "error" && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-danger" role="alert">
              {t("clipShare.loadFailed")}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              {t("clipShare.retry")}
            </Button>
          </div>
        )}
        {status === "ok" && share && (
          <>
            <p className="text-sm text-secondary-foreground smart-capitalize">
              {share.label} · {shareCameraName(share.camera)}
            </p>
            {share.has_clip && videoFailed && (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-danger" role="alert">
                  {t("clipShare.playFailed")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={retry}
                >
                  {t("clipShare.retry")}
                </Button>
              </div>
            )}
            {share.has_clip && !videoFailed && (
              // Shared clips have no caption track; this is a silent NVR recording.
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                className="w-full rounded-md bg-black"
                controls
                playsInline
                src={`${baseUrl}api/fork/share/${token}/clip.mp4`}
                aria-label={t("clipShare.play")}
                onError={() => setVideoFailed(true)}
              />
            )}
            {!share.has_clip && (
              <p className="text-sm text-secondary-foreground" role="status">
                {t("clipShare.noClip")}
              </p>
            )}
            <div
              className="mx-auto size-44 rounded-md bg-white p-2"
              role="img"
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
