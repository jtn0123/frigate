import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  clearNavigationSamples,
  navigationSnapshot,
  subscribeNavigation,
} from "@/lib/fork/navigation-metrics";

export default function NavigationMetrics() {
  const { t } = useTranslation("fork");
  const samples = useSyncExternalStore(subscribeNavigation, navigationSnapshot);
  const requests = samples.filter((sample) => sample.kind === "request");
  const completed = requests.filter((sample) => sample.outcome === "success");
  const durations = completed
    .map((sample) => sample.duration)
    .sort((a, b) => a - b);
  const p95 = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)];
  const latestPage = samples.filter((sample) => sample.kind === "page").at(-1);
  const rows = [
    [t("navigation.metrics.requests"), requests.length],
    [
      t("navigation.metrics.p95"),
      p95 === undefined
        ? t("navigation.metrics.unmeasured")
        : `${Math.round(p95)} ms`,
    ],
    [
      t("navigation.metrics.failures"),
      requests.filter((sample) => sample.outcome === "error").length,
    ],
    [
      t("navigation.metrics.cancelled"),
      requests.filter((sample) => sample.outcome === "cancelled").length,
    ],
    [
      t("navigation.metrics.ready"),
      latestPage
        ? `${Math.round(latestPage.duration)} ms`
        : t("navigation.metrics.unmeasured"),
    ],
  ];
  return (
    <details
      className="m-2 rounded-lg border border-border p-3"
      data-testid="navigation-metrics"
    >
      <summary className="cursor-pointer font-medium">
        {t("navigation.metrics.title")}
      </summary>
      <p className="my-2 text-sm text-secondary-foreground">
        {t("navigation.metrics.description")}
      </p>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded bg-secondary p-2">
            <dt>{label}</dt>
            <dd className="font-mono">{value}</dd>
          </div>
        ))}
      </dl>
      <Button size="sm" className="mt-2" onClick={clearNavigationSamples}>
        {t("navigation.metrics.clear")}
      </Button>
    </details>
  );
}
