/**
 * Fork (I57): what go2rtc says about one camera's source, in the Health drawer.
 *
 * A source that keeps timing out never shows in the frame rate of a camera
 * that reads a different stream, so this lists each go2rtc stream the camera
 * depends on and whether go2rtc is connected to it. The backend sends only the
 * scheme and host of a source, never its URL.
 */

import type { IconType } from "react-icons";
import { useTranslation } from "react-i18next";
import { LuCircleCheck, LuCircleSlash, LuUnplug } from "react-icons/lu";

import { cn } from "@/lib/utils";
import { useGo2rtcState } from "@/hooks/fork/use-go2rtc-state";
import {
  receiveRate,
  sourceStatus,
  type SourceStatus,
} from "@/lib/fork/go2rtc-state";

/** Icon and color per state; the text beside it carries the meaning. */
const STATUS: Record<SourceStatus, { icon: IconType; className: string }> = {
  connected: { icon: LuCircleCheck, className: "text-success" },
  notConnected: { icon: LuUnplug, className: "text-orange-400" },
  notConfigured: { icon: LuCircleSlash, className: "text-muted-foreground" },
};

type CameraSourceStateProps = {
  camera: string;
};

export default function CameraSourceState({
  camera,
}: Readonly<CameraSourceStateProps>) {
  const { t } = useTranslation(["fork"]);
  // Mounted only inside the open drawer, so it polls only while that is open.
  const { data, error } = useGo2rtcState(true);

  const streams = data?.cameras[camera]?.streams ?? [];
  let message: string | undefined;
  if (data === undefined && !error) {
    message = t("cameraHealth.source.loading");
  } else if (data === undefined || !data.available) {
    message = t("cameraHealth.source.unavailable");
  } else if (streams.length === 0) {
    message = t("cameraHealth.source.none");
  }

  return (
    <section
      className="mt-6"
      aria-label={t("cameraHealth.source.title")}
      data-testid="source-state"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("cameraHealth.source.title")}
      </h3>
      {message === undefined ? (
        <>
          <ul className="mt-2 flex flex-col gap-2">
            {streams.map((stream) => {
              const status = sourceStatus(stream);
              const { icon: Icon, className } = STATUS[status];
              const rate = receiveRate(stream.bytes_per_second);
              const details: string[] = [];
              if (stream.source) details.push(stream.source);
              if (status === "connected") {
                details.push(
                  rate
                    ? t(`cameraHealth.source.rate.${rate.unit}`, {
                        value: rate.value,
                      })
                    : t("cameraHealth.source.measuring"),
                );
              }
              if (status !== "notConfigured") {
                details.push(
                  t("cameraHealth.source.consumers", {
                    count: stream.consumers,
                  }),
                );
              }
              if (stream.codecs.length > 0) {
                details.push(stream.codecs.join(", "));
              }
              return (
                <li
                  key={stream.name}
                  className="flex gap-3 rounded-lg border border-secondary p-3"
                  data-testid="source-state-stream"
                  data-state={status}
                >
                  <Icon
                    className={cn("mt-0.5 size-4 shrink-0", className)}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 text-sm">
                      <span className="min-w-0 break-all font-semibold">
                        {stream.name}
                      </span>
                      <span className={className}>
                        {t(`cameraHealth.source.state.${status}`)}
                      </span>
                    </div>
                    {details.length > 0 && (
                      <p className="mt-0.5 break-all text-sm tabular-nums text-muted-foreground">
                        {details.join(" · ")}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {streams.some(
            (stream) => sourceStatus(stream) === "notConnected",
          ) && (
            <p
              className="mt-2 text-xs text-muted-foreground"
              data-testid="source-state-hint"
            >
              {t("cameraHealth.source.idleHint")}
            </p>
          )}
        </>
      ) : (
        <p
          className="mt-2 text-sm text-muted-foreground"
          data-testid="source-state-message"
        >
          {message}
        </p>
      )}
    </section>
  );
}
