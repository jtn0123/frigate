import useSWR from "swr";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCpu } from "react-icons/lu";
import ErrorState from "@/components/fork/ErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { AIModelsResponse } from "@/types/aiModels";
import { wrapAsync } from "@/utils/promise";
import { cn } from "@/lib/utils";
import AIModelGraphs from "@/views/system/AIModelGraphs";
import {
  appendHistory,
  MetricField,
  missingReason,
} from "@/utils/aiModelMetrics";

type Props = {
  isActive: boolean;
  setLastUpdated: (time: number) => void;
};

export default function AIModelMetrics({
  isActive,
  setLastUpdated,
}: Readonly<Props>) {
  const { t, i18n } = useTranslation(["views/system"]);
  const [history, setHistory] = useState<AIModelsResponse[]>([]);
  const { data, error, mutate } = useSWR<AIModelsResponse, Error>(
    isActive ? "ai/models" : null,
    { refreshInterval: 10000, revalidateOnFocus: true },
  );
  useEffect(() => {
    if (data) {
      setLastUpdated(data.updated);
      setHistory((previous) => appendHistory(previous, data));
    }
  }, [data, setLastUpdated]);
  const unknown = t("models.notMeasured");
  const fields: Record<string, MetricField> = {
    ram: "ram_bytes",
    disk: "disk_bytes",
    cpu: "cpu_percent",
    vram: "gpu_memory_bytes",
    latency: "latency_ms",
    load: "load_ms",
    peak: "peak_ram_bytes",
    lastUsed: "last_used",
  };
  const numeric = (value: number | null | undefined, suffix: string) =>
    value == null
      ? unknown
      : `${value.toLocaleString(i18n.language, { maximumFractionDigits: 1 })} ${suffix}`;
  const bytes = (value: number | null | undefined) => {
    if (value == null) return unknown;
    return value >= 1024 ** 3
      ? numeric(value / 1024 ** 3, "GiB")
      : numeric(value / 1024 ** 2, "MiB");
  };

  if (error)
    return (
      <ErrorState
        className="mt-4"
        error={error}
        onRetry={wrapAsync(() => mutate())}
      />
    );
  if (!data) return <Skeleton className="mt-4 h-64 w-full rounded-lg" />;

  return (
    <div className="scrollbar-container mt-4 flex min-h-0 flex-col gap-4 overflow-y-auto pb-4">
      <div>
        <h2 className="text-lg font-medium">{t("models.title")}</h2>
        <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
          {t("models.description")}
        </p>
      </div>
      <AIModelGraphs history={history} data={data} />
      <details className="rounded-xl border border-secondary p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {t("models.missing.title")}
        </summary>
        <p className="mt-3 text-sm text-muted-foreground">
          {t("models.missing.intro")}
        </p>
        <dl className="mt-3 grid gap-3 text-sm md:grid-cols-2">
          {[
            "remoteCollector",
            "awaitingRequest",
            "awaitingRun",
            "sharedGpu",
            "notInstrumented",
            "fileInventory",
            "stale",
            "includedInRun",
          ].map((reason) => (
            <div key={reason}>
              <dt className="font-medium">
                {t(`models.missing.${reason}.label`)}
              </dt>
              <dd className="text-muted-foreground">
                {t(`models.missing.${reason}.detail`)}
              </dd>
            </div>
          ))}
        </dl>
      </details>
      <section
        className="rounded-xl border border-secondary p-4"
        aria-label={t("models.queueTitle")}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{t("models.queueTitle")}</h3>
          <span
            className={cn(
              "text-sm",
              data.audio.status === "connected"
                ? "text-success"
                : "text-warning",
            )}
          >
            {t(`models.connection.${data.audio.status}`)}
          </span>
        </div>
        {data.audio.pause_reason && (
          <p className="mt-2 text-sm text-warning">
            {t(`models.pause.${data.audio.pause_reason}`)}
          </p>
        )}
        <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
          {[
            ["pending", numeric(data.audio.pending, "")],
            ["completed", numeric(data.audio.completed, "")],
            ["failed", numeric(data.audio.failed, "")],
            ["expired", numeric(data.audio.expired, "")],
            ["oldestWait", numeric(data.audio.oldest_wait_seconds, "s")],
            ["available", bytes(data.audio.available_bytes)],
          ].map(([key, value]) => (
            <div key={key}>
              <dt className="text-xs text-muted-foreground">
                {t(`models.${key}`)}
              </dt>
              <dd className="mt-1 font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      {data.models.length === 0 && (
        <p className="text-muted-foreground">{t("models.empty")}</p>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.models.map((model) => (
          <article
            key={model.id}
            className="min-w-0 rounded-xl bg-background_alt p-4"
            aria-label={model.name}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 gap-2">
                <LuCpu className="mt-1 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <h3 className="break-words font-medium">{model.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t(`models.roles.${model.role}`)}
                  </p>
                </div>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-md bg-secondary px-2 py-1 text-xs",
                  ["stale", "unavailable", "missing"].includes(model.status) &&
                    "text-warning",
                )}
              >
                {t(`models.states.${model.status}`)}
              </span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {t(`models.locations.${model.location}`)} · {model.device}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4">
              {[
                ["ram", bytes(model.ram_bytes)],
                ["disk", bytes(model.disk_bytes)],
                ["cpu", numeric(model.cpu_percent, "%")],
                ["vram", bytes(model.gpu_memory_bytes)],
                ["latency", numeric(model.latency_ms, "ms")],
                ["load", numeric(model.load_ms, "ms")],
                ["peak", bytes(model.peak_ram_bytes)],
                [
                  "lastUsed",
                  model.last_used == null
                    ? unknown
                    : new Date(model.last_used * 1000).toLocaleString(
                        i18n.language,
                      ),
                ],
              ].map(([key, value]) => (
                <div key={key}>
                  <dt className="text-xs text-muted-foreground">
                    {t(`models.${key}`)}
                  </dt>
                  <dd
                    className="mt-1 break-words text-sm tabular-nums"
                    title={
                      model[fields[key]] == null
                        ? t(
                            `models.missing.${missingReason(model, fields[key])}.detail`,
                          )
                        : undefined
                    }
                  >
                    {model[fields[key]] == null
                      ? t(
                          `models.missing.${missingReason(model, fields[key])}.label`,
                        )
                      : value}
                  </dd>
                </div>
              ))}
              {model.context_length != null && (
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("models.context")}
                  </dt>
                  <dd className="mt-1 text-sm">
                    {numeric(model.context_length, "")}
                  </dd>
                </div>
              )}
            </dl>
            <p className="mt-4 border-t border-secondary pt-3 text-xs text-muted-foreground">
              {t(`models.scopes.${model.resource_scope}`)}
            </p>
          </article>
        ))}
      </div>
      <section className="rounded-xl border border-secondary p-4">
        <h3 className="font-medium">{t("models.sharedGpu")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("models.sharedGpuDescription")}
        </p>
        {Object.entries(data.shared_gpus).map(([name, gpu]) => (
          <div
            key={name}
            className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm"
          >
            <span>{name}</span>
            <span>
              {t("models.gpuUtilization")}: {gpu.gpu ?? unknown}
            </span>
            <span>
              {t("models.gpuMemory")}: {gpu.mem ?? unknown}
            </span>
            <span>
              {t("models.temperature")}: {numeric(gpu.temp, "°C")}
            </span>
          </div>
        ))}
        {Object.keys(data.shared_gpus).length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground">{unknown}</p>
        )}
      </section>
    </div>
  );
}
