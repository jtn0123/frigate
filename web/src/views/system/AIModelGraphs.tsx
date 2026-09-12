import { useMemo, useState } from "react";
import Chart from "react-apexcharts";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/context/theme-provider";
import { AIModelsResponse } from "@/types/aiModels";
import { graphPoints, readMetric } from "@/utils/aiModelMetrics";

type Series = { name: string; data: { x: number; y: number | null }[] }[];

function HistoryChart({
  title,
  series,
  unit,
}: Readonly<{
  title: string;
  series: Series;
  unit: string;
}>) {
  const { t, i18n } = useTranslation(["views/system"]);
  const { theme, systemTheme } = useTheme();
  const resolvedTheme = theme === "system" ? systemTheme : theme;
  const times = series.flatMap((item) => item.data.map((point) => point.x));
  const first = times.length ? Math.min(...times) : undefined;
  const last = times.length ? Math.max(...times) : undefined;
  const single = first === last;
  const options = useMemo<ApexCharts.ApexOptions>(
    () => ({
      chart: {
        type: "line",
        animations: { enabled: false },
        toolbar: { show: false },
        zoom: { enabled: false },
        fontFamily: "inherit",
        background: "transparent",
      },
      theme: {
        mode: resolvedTheme === "dark" ? "dark" : "light",
      },
      colors: ["#3b82f6", "#f59e0b", "#10b981"],
      stroke: { width: single ? 0 : 2, curve: "straight" },
      markers: { size: 2 },
      dataLabels: { enabled: false },
      grid: { borderColor: "#88888825", strokeDashArray: 3 },
      xaxis: {
        type: "datetime",
        min: first == null ? undefined : first - 10000,
        max: last == null ? undefined : last + 10000,
        labels: { datetimeUTC: false, format: "HH:mm:ss" },
        tooltip: { enabled: false },
      },
      yaxis: {
        min: 0,
        forceNiceScale: true,
        labels: {
          formatter: (value) =>
            Number.isFinite(value)
              ? `${value.toLocaleString(i18n.language, { maximumFractionDigits: 1 })} ${unit}`
              : "",
        },
      },
      tooltip: {
        x: {
          formatter: (value) =>
            new Date(value).toLocaleTimeString(i18n.language),
        },
      },
      legend: { show: true, position: "bottom" },
    }),
    [resolvedTheme, unit, i18n.language, first, last, single],
  );
  const count = series.reduce(
    (sum, item) => sum + item.data.filter((point) => point.y != null).length,
    0,
  );
  return (
    <section
      className="min-w-0 rounded-xl border border-secondary p-3"
      aria-label={title}
    >
      <h3 className="text-sm font-medium">{title}</h3>
      {count ? (
        <Chart options={options} series={series} type="line" height={190} />
      ) : (
        <div className="flex h-[190px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t("models.graphs.noSamples")}
        </div>
      )}
    </section>
  );
}

export default function AIModelGraphs({
  history,
  data,
}: Readonly<{
  history: AIModelsResponse[];
  data: AIModelsResponse;
}>) {
  const { t } = useTranslation(["views/system"]);
  const [selected, setSelected] = useState("");
  const fallbackId = data.models.length ? data.models[0].id : "";
  const id = data.models.some((model) => model.id === selected)
    ? selected
    : fallbackId;
  const model = data.models.find((item) => item.id === id);
  const series = (
    field: "ram_bytes" | "cpu_percent" | "latency_ms" | "gpu_memory_bytes",
    scale = 1,
  ): Series => [
    {
      name: model?.name ?? "",
      data: graphPoints(history, (point) => {
        const value = readMetric(point, id, field);
        return value == null ? null : value / scale;
      }),
    },
  ];
  const gpuSeries: Series = Object.keys(data.shared_gpus).flatMap((name) =>
    ["gpu", "mem"].map((field) => ({
      name: `${name}: ${t(field === "gpu" ? "models.gpuUtilization" : "models.gpuMemory")}`,
      data: graphPoints(history, (point) => {
        const raw = Object.prototype.hasOwnProperty.call(
          point.shared_gpus,
          name,
        )
          ? point.shared_gpus[name][field as "gpu" | "mem"]
          : null;
        return raw == null ? null : Number.parseFloat(raw);
      }),
    })),
  );
  return (
    <section className="space-y-3" aria-label={t("models.graphs.title")}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-medium">{t("models.graphs.title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("models.graphs.description")}
          </p>
        </div>
        <label
          htmlFor="ai-history-model"
          className="flex items-center gap-2 text-sm"
        >
          {t("models.graphs.model")}
          <select
            id="ai-history-model"
            className="max-w-56 rounded-md border border-secondary bg-background px-3 py-2"
            value={id}
            onChange={(event) => setSelected(event.target.value)}
          >
            {data.models.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <HistoryChart
          title={t("models.graphs.ram")}
          series={series("ram_bytes", 1024 ** 3)}
          unit="GiB"
        />
        <HistoryChart
          title={t("models.graphs.cpu")}
          series={series("cpu_percent")}
          unit="%"
        />
        <HistoryChart
          title={t("models.graphs.latency")}
          series={series("latency_ms", 1000)}
          unit="s"
        />
        <HistoryChart
          title={t("models.graphs.vram")}
          series={series("gpu_memory_bytes", 1024 ** 3)}
          unit="GiB"
        />
        <HistoryChart
          title={t("models.graphs.queue")}
          series={[
            {
              name: t("models.pending"),
              data: graphPoints(history, (point) =>
                point.audio.status === "connected" ? point.audio.pending : null,
              ),
            },
          ]}
          unit=""
        />
        <HistoryChart
          title={t("models.sharedGpu")}
          series={gpuSeries}
          unit="%"
        />
      </div>
      {history.length < 2 && (
        <p className="text-xs text-muted-foreground">
          {t("models.graphs.waiting")}
        </p>
      )}
    </section>
  );
}
