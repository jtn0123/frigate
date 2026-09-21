import { useEffect, useState } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { LivePlayerError } from "@/types/live";
import { Button } from "@/components/ui/button";

import type { components } from "@/types/fork/api.gen";

type Diagnostics = components["schemas"]["StreamDiagnosticsResponse"];
type DiagnosticState = Pick<Diagnostics, "status"> &
  Partial<Pick<Diagnostics, "id" | "codecs">>;

export function LivePlaybackError({
  streamName,
  reason,
  mediaErrorCode,
  onRetry,
}: Readonly<{
  streamName: string;
  reason: LivePlayerError;
  mediaErrorCode?: number;
  onRetry: () => void;
}>) {
  const { t } = useTranslation("views/live");
  const [diagnostics, setDiagnostics] = useState<DiagnosticState>();

  useEffect(() => {
    const controller = new AbortController();
    setDiagnostics(undefined);
    axios
      .post<Diagnostics>(
        `go2rtc/streams/${encodeURIComponent(streamName)}/diagnostics`,
        { reason, media_error_code: mediaErrorCode },
        { signal: controller.signal, timeout: 20_000 },
      )
      .then(({ data }) => {
        if (!controller.signal.aborted) setDiagnostics(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setDiagnostics({ status: "unavailable" });
        }
      });
    return () => controller.abort();
  }, [streamName, reason, mediaErrorCode]);

  let failureMessage = t("playbackError.startup");
  if (reason === "mse-decode") {
    failureMessage = t("playbackError.decode");
  } else if (reason === "stalled") {
    failureMessage = t("playbackError.stalled");
  }

  return (
    <div
      role="alert"
      className="absolute inset-0 z-40 flex items-center justify-center rounded-lg bg-background/95 p-4 md:rounded-2xl"
    >
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <p className="font-semibold">{t("playbackError.title")}</p>
        <p className="text-sm text-muted-foreground">{failureMessage}</p>
        <p className="text-sm" aria-live="polite">
          {diagnostics
            ? t(`playbackError.diagnostics.${diagnostics.status}`)
            : t("playbackError.checking")}
        </p>
        {diagnostics?.id && (
          <p className="text-xs text-muted-foreground">
            {t("playbackError.reference", { id: diagnostics.id })}
          </p>
        )}
        <Button
          onClick={(event) => {
            event.stopPropagation();
            onRetry();
          }}
        >
          {t("playbackError.retry")}
        </Button>
      </div>
    </div>
  );
}
