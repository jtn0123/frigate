import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

type Series = { name: string; data: { x: number; y: number | null }[] }[];
const PAGE_SIZE = 25;

export default function MetricHistoryTable({
  title,
  series,
  unit,
}: Readonly<{ title: string; series: Series; unit: string }>) {
  const { t, i18n } = useTranslation(["views/system"]);
  const [page, setPage] = useState(0);
  const rows = useMemo(
    () =>
      series
        .flatMap((item) =>
          item.data.map((point) => ({ ...point, name: item.name })),
        )
        .sort((a, b) => b.x - a.x || a.name.localeCompare(b.name)),
    [series],
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  return (
    <details className="mt-2 text-sm">
      <summary className="min-h-11 cursor-pointer rounded-sm py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-selected">
        {t("models.graphs.table", { title })}
      </summary>
      <p className="mb-2 text-xs text-muted-foreground">
        {t("models.graphs.tableDescription")}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col" className="p-2">
                {t("models.graphs.time")}
              </th>
              <th scope="col" className="p-2">
                {t("models.graphs.series")}
              </th>
              <th scope="col" className="p-2">
                {t("models.graphs.value")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows
              .slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
              .map((row, index) => (
                <tr
                  key={`${row.name}-${row.x}-${index}`}
                  className="border-t border-secondary"
                >
                  <th scope="row" className="p-2 font-normal">
                    {new Date(row.x).toLocaleString(i18n.language)}
                  </th>
                  <td className="p-2">{row.name}</td>
                  <td className="p-2 tabular-nums">
                    {row.y == null
                      ? t("models.graphs.gap")
                      : `${row.y.toLocaleString(i18n.language, { maximumSignificantDigits: 4 })} ${unit}`}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p>{t("models.graphs.noSamples")}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={current === 0}
          onClick={() => setPage(current - 1)}
        >
          {t("models.graphs.previous")}
        </Button>
        <span aria-live="polite">
          {t("models.graphs.page", {
            current: current + 1,
            total: pages,
            readings: rows.length,
          })}
        </span>
        <Button
          variant="outline"
          disabled={current + 1 === pages}
          onClick={() => setPage(current + 1)}
        >
          {t("models.graphs.next")}
        </Button>
      </div>
    </details>
  );
}
