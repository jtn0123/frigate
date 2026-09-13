import { AIModelsResponse } from "@/types/aiModels";
import { useTranslation } from "react-i18next";

export default function AIModelReadiness({
  data,
}: Readonly<{ data: AIModelsResponse }>) {
  const { t } = useTranslation("views/system");
  const unavailable = data.models.filter((model) =>
    ["stale", "unavailable", "missing", "unknown"].includes(model.status),
  );
  const problems =
    data.telemetry_status !== "connected" ||
    unavailable.length > 0 ||
    data.audio.status !== "connected" ||
    Boolean(data.audio.pause_reason);
  return (
    <section
      className="rounded-xl border border-secondary p-4"
      aria-live="polite"
    >
      <h3
        className={
          problems ? "font-medium text-warning" : "font-medium text-success"
        }
      >
        {t(problems ? "models.readiness.attention" : "models.readiness.ready")}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("models.readiness.scope")}
      </p>
      {data.telemetry_status !== "connected" && (
        <p className="mt-2 text-sm text-warning">
          {t("models.readiness.stale")}
        </p>
      )}
      {unavailable.length > 0 && (
        <p className="mt-2 text-sm">
          {t("models.readiness.unavailable", { count: unavailable.length })}
        </p>
      )}
      {data.history_status !== "connected" && (
        <p className="mt-2 text-sm text-warning">
          {t("models.readiness.history")}
        </p>
      )}
    </section>
  );
}
