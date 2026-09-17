import { useTranslation } from "react-i18next";
import { AIModelsResponse } from "@/types/aiModels";
import TimeAgo from "@/components/dynamic/TimeAgo";
import { useMetricTimeFormatter } from "@/hooks/fork/use-metric-time";

type Stability = NonNullable<AIModelsResponse["server"]>["stability"];

export default function StabilityIncidents({
  data,
}: Readonly<{ data: Stability }>) {
  const { t } = useTranslation("views/system");
  const formatTime = useMetricTimeFormatter();
  const active = data?.incidents.filter((row) => row.resolved == null) ?? [];
  const fresh =
    data?.status === "connected" &&
    !active.some((row) => row.kind === "monitoring");
  const dimensions = ["server", "capture", "recording", "ai"];
  const groups: Record<string, string[]> = {
    server: ["server", "restart", "memory"],
    capture: ["capture"],
    recording: ["recording", "recording_unknown"],
    ai: ["ai", "detection", "audio"],
  };
  let status = t("stability.unavailable");
  if (fresh) {
    status =
      active.length === 0
        ? t("stability.clear")
        : t("stability.active", { count: active.length });
  }
  return (
    <section
      className="rounded-xl border border-secondary p-4"
      aria-label={t("stability.title")}
    >
      <h3 className="font-medium">{t("stability.title")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("stability.description")}
      </p>
      <div className="my-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        {dimensions.map((dimension) => {
          const problem = active.some((row) =>
            groups[dimension].includes(row.kind),
          );
          let state = "unknown";
          if (fresh) state = problem ? "attention" : "ok";
          return (
            <div key={dimension} className="rounded bg-background_alt p-2">
              <div>{t(`stability.dimensions.${dimension}`)}</div>
              <strong
                className={!fresh || problem ? "text-warning" : "text-success"}
              >
                {t(`stability.states.${state}`)}
              </strong>
            </div>
          );
        })}
      </div>
      <div role="status" aria-live="polite">
        {status}
      </div>
      <ul className="mt-2 space-y-2">
        {active.map((row) => (
          <li key={`${row.kind}:${row.scope}`} className="text-sm text-warning">
            {t(`stability.reasons.${row.kind}`)}: {row.scope}
            {row.started != null && (
              <span className="ml-2">
                <TimeAgo time={row.started * 1000} dense />
              </span>
            )}
          </li>
        ))}
      </ul>
      {data?.audio_failure?.updated != null && (
        <p className="mt-2 text-sm">
          {t("stability.audioFailure", {
            stage: t(`stability.stages.${data.audio_failure.stage}`),
            cause: t(`stability.causes.${data.audio_failure.cause}`),
          })}
          <span className="ml-2">
            <TimeAgo time={data.audio_failure.updated * 1000} dense />
          </span>
        </p>
      )}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {(["detector_ms", "skipped_fps"] as const).map((metric) => {
          const samples = data?.samples ?? [];
          const ceiling = Math.max(
            metric === "detector_ms" ? 30 : 0.5,
            ...samples.map((row) => row[metric] ?? 0),
          );
          return (
            <figure key={metric}>
              <figcaption className="text-sm">
                {t(`stability.graphs.${metric}`)}
              </figcaption>
              <svg
                viewBox="0 0 240 60"
                className="h-16 w-full"
                role="img"
                aria-label={t(`stability.graphs.${metric}`)}
              >
                {samples.map((row, index) =>
                  row[metric] == null ? null : (
                    <rect
                      key={`${row.time}:${index}`}
                      x={(index * 240) / Math.max(1, samples.length)}
                      y={60 - (row[metric] / ceiling) * 58}
                      width={Math.max(1, 240 / Math.max(1, samples.length) - 1)}
                      height={Math.max(1, (row[metric] / ceiling) * 58)}
                      className="fill-selected"
                    />
                  ),
                )}
              </svg>
            </figure>
          );
        })}
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer">{t("stability.evidence")}</summary>
        <p className="text-muted-foreground">{t("stability.sampleNote")}</p>
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-left tabular-nums">
            <thead>
              <tr>
                {["time", "latency", "skips", "requests"].map((key) => (
                  <th key={key}>{t(`stability.columns.${key}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.samples
                .slice()
                .reverse()
                .map((row, index) => (
                  <tr key={`${row.time}:${index}`}>
                    <td>
                      {row.time == null
                        ? t("models.notMeasured")
                        : formatTime(row.time, false)}
                    </td>
                    <td>
                      {row.detector_ms?.toFixed(1) ?? t("models.notMeasured")}
                    </td>
                    <td>
                      {row.skipped_fps?.toFixed(1) ?? t("models.notMeasured")}
                    </td>
                    <td>{row.ollama_requests ?? t("models.notMeasured")}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
