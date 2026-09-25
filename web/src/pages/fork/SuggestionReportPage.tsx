/**
 * The suggestion report for one custom classification model (fork I47).
 *
 * Everything the status line's tooltips hint at, on one page: how often
 * people kept the drafts, per class, camera and source, how many images
 * were auto-filed, and how often the trained model agreed with the
 * descriptions, with the latest disagreements linked to Explore.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { baseUrl } from "@/api/baseUrl";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { Button } from "@/components/ui/button";
import Heading from "@/components/ui/heading";
import { Toaster } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isForkEnabled } from "@/fork/flags";
import { useSpotCheck } from "@/hooks/fork/use-spot-check";
import { useSuggestionReport } from "@/hooks/fork/use-suggestion-report";
import {
  datasetImagePath,
  type Acceptance,
  type AutoFiledGroup,
  type ClassAcceptance,
  type DatasetBalance,
  type SuggestionReport,
} from "@/lib/fork/classification-suggestions";

function pct(rate: number | null | undefined): string {
  return rate == null ? "–" : `${Math.round(rate * 100)}%`;
}

function changedList(corrected: Record<string, number>): string {
  return Object.entries(corrected)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${n}`)
    .join(", ");
}

export default function SuggestionReportPage() {
  const { t } = useTranslation(["fork"]);
  const { model = "" } = useParams<{ model: string }>();
  const enabled = isForkEnabled("classificationSuggestions");
  const swr = useSuggestionReport(enabled ? model : "");
  const data = swr.data;
  const failed = Boolean(swr.error);

  if (!enabled) {
    return null;
  }

  return (
    <div
      data-testid="suggestion-report"
      className="flex size-full flex-col gap-4 overflow-y-auto p-2 md:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading as="h2">
          {t("classificationSuggestions.report.title", { model })}
        </Heading>
        <Link to="/classification" className="text-sm text-selected">
          {t("classificationSuggestions.report.back")}
        </Link>
      </div>
      <Toaster />
      {failed && (
        <div className="text-sm text-danger">
          {t("classificationSuggestions.report.failed")}
        </div>
      )}
      {!data && !failed && <ActivityIndicator />}
      {data && <ReportBody report={data} />}
    </div>
  );
}

function ReportBody({ report }: Readonly<{ report: SuggestionReport }>) {
  const { t } = useTranslation(["fork"]);
  const check = report.model_check;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat
          label={t("classificationSuggestions.report.reviewed")}
          value={String(report.total)}
        />
        <Stat
          label={t("classificationSuggestions.report.keptRate")}
          value={pct(report.rate)}
        />
        <Stat
          label={t("classificationSuggestions.report.autoFiled")}
          value={String(report.auto_filed ?? 0)}
        />
        <Stat
          label={t("classificationSuggestions.report.modelAgreement")}
          value={check && check.total > 0 ? pct(check.rate) : "–"}
        />
        <Stat
          label={t("classificationSuggestions.report.newSinceTraining")}
          value={String(report.training?.new_images ?? 0)}
          hint={
            report.training && !report.training.has_trained
              ? t("classificationSuggestions.report.neverTrained")
              : ""
          }
        />
      </div>

      {report.dataset && <BalanceSection balance={report.dataset} />}
      {(report.recent_auto_filed?.length ?? 0) > 0 && (
        <SpotCheckSection
          model={report.model}
          groups={report.recent_auto_filed ?? []}
        />
      )}

      <AcceptanceTable
        testId="report-classes"
        title={t("classificationSuggestions.report.byClass")}
        firstColumn={t("classificationSuggestions.report.class")}
        rows={report.classes}
        changedHeader={t("classificationSuggestions.report.changedTo")}
        autoHeader={t("classificationSuggestions.report.autoFiled")}
      />
      <AcceptanceTable
        testId="report-cameras"
        title={t("classificationSuggestions.report.byCamera")}
        firstColumn={t("classificationSuggestions.report.camera")}
        rows={report.cameras}
      />
      <AcceptanceTable
        testId="report-sources"
        title={t("classificationSuggestions.report.bySource")}
        firstColumn={t("classificationSuggestions.report.source")}
        rows={report.sources}
      />

      {check && check.total > 0 && (
        <>
          <AcceptanceTable
            testId="report-model-check"
            title={t("classificationSuggestions.report.modelCheck")}
            firstColumn={t("classificationSuggestions.report.modelSaid")}
            rows={check.classes}
            acceptedHeader={t("classificationSuggestions.report.agreed")}
            changedHeader={t(
              "classificationSuggestions.report.descriptionSaid",
            )}
          />
          {check.recent_disagreements.length > 0 && (
            <section
              data-testid="report-disagreements"
              className="flex flex-col gap-1"
            >
              <Heading as="h4">
                {t("classificationSuggestions.report.recentDisagreements")}
              </Heading>
              <ul className="flex flex-col gap-1 text-sm">
                {check.recent_disagreements.map((d, i) => (
                  <li
                    key={`${d.event_id ?? i}`}
                    className="flex flex-wrap items-center gap-x-2"
                  >
                    <span className="text-secondary-foreground">
                      {d.time != null
                        ? new Date(d.time * 1000).toLocaleString()
                        : ""}
                    </span>
                    <span>{d.camera}</span>
                    <span className="smart-capitalize">
                      {t("classificationSuggestions.report.saidVsDraft", {
                        said: d.model_said,
                        draft: d.draft,
                      })}
                    </span>
                    {d.event_id && (
                      <Link
                        to={`/explore?event_id=${encodeURIComponent(d.event_id)}`}
                        className="text-selected"
                      >
                        {t("classificationSuggestions.report.open")}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  hint,
}: Readonly<{ label: string; value: string; hint?: string }>) {
  return (
    <div className="flex flex-col rounded-lg bg-secondary p-3">
      <span className="text-xs text-secondary-foreground">{label}</span>
      <span className="text-xl font-medium">{value}</span>
      {hint && (
        <span className="text-xs text-secondary-foreground">{hint}</span>
      )}
    </div>
  );
}

/** Images per class, with a warning when one dwarfs another (fork I51). */
function BalanceSection({ balance }: Readonly<{ balance: DatasetBalance }>) {
  const { t } = useTranslation(["fork"]);
  const entries = Object.entries(balance.classes);
  if (entries.length === 0) {
    return null;
  }
  return (
    <section data-testid="report-balance" className="flex flex-col gap-1">
      <Heading as="h4">{t("classificationSuggestions.report.balance")}</Heading>
      {balance.lopsided && (
        <div className="text-sm text-warning">
          {t("classificationSuggestions.report.lopsided", {
            largest: balance.largest ?? "",
            smallest: balance.smallest ?? "",
            ratio: balance.ratio ?? 0,
          })}
        </div>
      )}
      {balance.empty.length > 0 && (
        <div className="text-sm text-secondary-foreground">
          {t("classificationSuggestions.report.emptyClasses", {
            list: balance.empty.join(", "),
          })}
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("classificationSuggestions.report.class")}</TableHead>
            <TableHead>
              {t("classificationSuggestions.report.images")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([name, count]) => (
            <TableRow key={name}>
              <TableCell className="smart-capitalize">{name}</TableCell>
              <TableCell>{count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

/** The latest auto-filed groups, each kept or removed with one tap (fork I52). */
function SpotCheckSection({
  model,
  groups,
}: Readonly<{ model: string; groups: AutoFiledGroup[] }>) {
  const { t } = useTranslation(["fork"]);
  const spotCheck = useSpotCheck(model);
  const [pending, setPending] = useState<string | null>(null);

  const decide = async (group: AutoFiledGroup, keep: boolean) => {
    const key = `${group.event_id ?? ""}:${group.category}`;
    setPending(key);
    try {
      await spotCheck(group, keep);
    } finally {
      setPending(null);
    }
  };

  return (
    <section data-testid="report-spot-check" className="flex flex-col gap-1">
      <Heading as="h4">
        {t("classificationSuggestions.report.spotCheck", {
          count: groups.length,
        })}
      </Heading>
      <div className="text-sm text-secondary-foreground">
        {t("classificationSuggestions.report.spotCheckHint")}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {groups.map((group) => {
          const key = `${group.event_id ?? ""}:${group.category}`;
          const busy = pending === key;
          return (
            <div
              key={key}
              data-testid="spot-check-group"
              className="flex flex-col gap-1 rounded-lg bg-secondary p-2 text-sm"
            >
              <img
                className="aspect-square w-full rounded object-cover"
                src={`${baseUrl}${datasetImagePath(model, group.category, group.files[0] ?? "")}`}
                alt={group.category}
                loading="lazy"
              />
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium smart-capitalize">
                  {group.category}
                </span>
                <span className="text-xs text-secondary-foreground">
                  {t("classificationSuggestions.report.imageCount", {
                    count: group.files.length,
                  })}
                </span>
              </div>
              <div className="text-xs text-secondary-foreground">
                {group.camera}
                {group.time != null &&
                  ` · ${new Date(group.time * 1000).toLocaleString()}`}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="select"
                  className="h-6 px-2 text-xs"
                  disabled={busy}
                  onClick={() => void decide(group, true)}
                >
                  {t("classificationSuggestions.report.keep")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  disabled={busy}
                  onClick={() => void decide(group, false)}
                >
                  {t("classificationSuggestions.report.remove")}
                </Button>
                {group.event_id && (
                  <Link
                    to={`/explore?event_id=${encodeURIComponent(group.event_id)}`}
                    className="ml-auto text-xs text-selected"
                  >
                    {t("classificationSuggestions.report.open")}
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type AcceptanceTableProps = {
  testId: string;
  title: string;
  firstColumn: string;
  rows: Record<string, Acceptance | ClassAcceptance>;
  acceptedHeader?: string;
  changedHeader?: string;
  autoHeader?: string;
};

function AcceptanceTable({
  testId,
  title,
  firstColumn,
  rows,
  acceptedHeader,
  changedHeader,
  autoHeader,
}: Readonly<AcceptanceTableProps>) {
  const { t } = useTranslation(["fork"]);
  const entries = Object.entries(rows);
  if (entries.length === 0) {
    return null;
  }
  return (
    <section data-testid={testId} className="flex flex-col gap-1">
      <Heading as="h4">{title}</Heading>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{firstColumn}</TableHead>
            <TableHead>
              {t("classificationSuggestions.report.reviewed")}
            </TableHead>
            <TableHead>
              {acceptedHeader ?? t("classificationSuggestions.report.kept")}
            </TableHead>
            {changedHeader && <TableHead>{changedHeader}</TableHead>}
            {autoHeader && <TableHead>{autoHeader}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([name, stats]) => (
            <TableRow key={name}>
              <TableCell className="smart-capitalize">{name}</TableCell>
              <TableCell>{stats.total}</TableCell>
              <TableCell>
                {stats.accepted} ({pct(stats.rate)})
              </TableCell>
              {changedHeader && (
                <TableCell className="smart-capitalize">
                  {"corrected_to" in stats
                    ? changedList(stats.corrected_to)
                    : ""}
                </TableCell>
              )}
              {autoHeader && (
                <TableCell>
                  {"auto_filed" in stats ? (stats.auto_filed ?? 0) : 0}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
