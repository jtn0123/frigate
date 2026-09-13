import { AIModelsResponse } from "@/types/aiModels";
import { useTranslation } from "react-i18next";

export default function ServerPressure({
  server,
}: Readonly<{ server: AIModelsResponse["server"] }>) {
  const { t, i18n } = useTranslation("views/system");
  const value = (number: number | null | undefined, unit: string, scale = 1) =>
    number == null
      ? t("models.notMeasured")
      : `${(number / scale).toLocaleString(i18n.language, { maximumFractionDigits: 1 })} ${unit}`;
  return (
    <section className="rounded-xl border border-secondary p-4">
      <h3 className="font-medium">{t("models.server.title")}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("models.server.scope")}
      </p>
      {server?.status !== "connected" && (
        <p className="mt-2 text-sm text-warning">
          {t("models.server.unavailable")}
        </p>
      )}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {server?.scopes.map((scope) => (
          <article
            key={`${scope.scope}:${scope.id}`}
            className="rounded-lg bg-background_alt p-3"
          >
            <h4 className="font-medium">
              {t(`models.server.scopes.${scope.scope}`)} {scope.id}
            </h4>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
              {[
                ["ram", value(scope.memory_bytes, "GiB", 1024 ** 3)],
                ["limit", value(scope.memory_limit_bytes, "GiB", 1024 ** 3)],
                ["cpu", value(scope.cpu_percent, "%")],
                ["quota", value(scope.cpu_limit, "")],
                ["swap", value(scope.swap_bytes, "MiB", 1024 ** 2)],
                ["pressure", value(scope.memory_pressure, "%")],
                ["oom", value(scope.oom_kills, "")],
                ["disk", value(scope.disk_free_bytes, "GiB", 1024 ** 3)],
              ].map(([key, metric]) => (
                <div key={key}>
                  <dt className="text-muted-foreground">
                    {t(`models.server.fields.${key}`)}
                  </dt>
                  <dd className="tabular-nums">{metric}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
