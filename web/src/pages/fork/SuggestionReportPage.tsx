/**
 * The suggestion report for one custom classification model (fork I47).
 *
 * Everything the status line's tooltips hint at, on one page: how often
 * people accepted the guesses, per class, camera and source, how many were
 * added automatically or in bulk, and how often the trained model agreed
 * with the descriptions, with the latest disagreements linked to Explore.
 * Every number carries a one-line explanation in plain words.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { baseUrl } from "@/api/baseUrl";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
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
  modelLabel,
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
          {t("classificationSuggestions.report.title", {
            model: modelLabel(model),
          })}
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
          description={t("classificationSuggestions.report.reviewedHint")}
        />
        <Stat
          label={t("classificationSuggestions.report.keptRate")}
          value={pct(report.rate)}
          description={t("classificationSuggestions.report.keptRateHint")}
        />
        <Stat
          label={t("classificationSuggestions.report.autoFiled")}
          value={String(report.auto_filed ?? 0)}
          description={t("classificationSuggestions.report.autoFiledHint")}
        />
        <Stat
          label={t("classificationSuggestions.report.modelAgreement")}
          value={check && check.total > 0 ? pct(check.rate) : "–"}
          description={t("classificationSuggestions.report.modelAgreementHint")}
        />
        <Stat
          label={t("classificationSuggestions.report.newSinceTraining")}
          value={String(report.training?.new_images ?? 0)}
          description={t(
            "classificationSuggestions.report.newSinceTrainingHint",
          )}
          hint={
            report.training && !report.training.has_trained
              ? t("classificationSuggestions.report.neverTrained")
              : ""
          }
        />
      </div>
      {report.bulk_accepted != null && (
        <div data-testid="report-bulk" className="flex flex-col text-sm">
          <span>
            {t("classificationSuggestions.report.bulkAccepted", {
              count: report.bulk_accepted,
            })}
          </span>
          <span className="text-xs text-secondary-foreground">
            {t("classificationSuggestions.report.bulkAcceptedHint")}
          </span>
        </div>
      )}

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
        description={t("classificationSuggestions.report.byClassHint")}
        firstColumn={t("classificationSuggestions.report.class")}
        rows={report.classes}
        changedHeader={t("classificationSuggestions.report.changedTo")}
        autoHeader={t("classificationSuggestions.report.autoFiled")}
        bulkHeader={
          report.bulk_accepted != null
            ? t("classificationSuggestions.report.bulkAcceptedColumn")
            : undefined
        }
      />
      <AcceptanceTable
        testId="report-cameras"
        title={t("classificationSuggestions.report.byCamera")}
        description={t("classificationSuggestions.report.byCameraHint")}
        firstColumn={t("classificationSuggestions.report.camera")}
        rows={report.cameras}
      />
      <AcceptanceTable
        testId="report-sources"
        title={t("classificationSuggestions.report.bySource")}
        description={t("classificationSuggestions.report.bySourceHint")}
        firstColumn={t("classificationSuggestions.report.source")}
        rows={report.sources}
      />

      {check && check.total > 0 && (
        <>
          <AcceptanceTable
            testId="report-model-check"
            title={t("classificationSuggestions.report.modelCheck")}
            description={t("classificationSuggestions.report.modelCheckHint")}
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
              <div className="text-sm text-secondary-foreground">
                {t("classificationSuggestions.report.recentDisagreementsHint")}
              </div>
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
  description,
  hint,
}: Readonly<{
  label: string;
  value: string;
  /** One line saying what the number counts, in plain words. */
  description: string;
  hint?: string;
}>) {
  return (
    <div className="flex flex-col rounded-lg bg-secondary p-3">
      <span className="text-xs text-secondary-foreground">{label}</span>
      <span className="text-xl font-medium">{value}</span>
      <span className="text-xs text-secondary-foreground">{description}</span>
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
      <div className="text-sm text-secondary-foreground">
        {t("classificationSuggestions.report.balanceHint")}
      </div>
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

/**
 * The latest auto-filed groups, each kept with one tap or removed after a
 * confirmation, since a removal deletes the photos for good (fork I52).
 */
function SpotCheckSection({
  model,
  groups,
}: Readonly<{ model: string; groups: AutoFiledGroup[] }>) {
  const { t } = useTranslation(["fork"]);
  const spotCheck = useSpotCheck(model);
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AutoFiledGroup | null>(null);

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
                  aria-label={t("classificationSuggestions.report.keepAria", {
                    category: group.category,
                    camera: group.camera ?? "",
                  })}
                  onClick={() => void decide(group, true)}
                >
                  {t("classificationSuggestions.report.keep")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  disabled={busy}
                  aria-label={t("classificationSuggestions.report.removeAria", {
                    category: group.category,
                    camera: group.camera ?? "",
                  })}
                  onClick={() => setRemoving(group)}
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
      <AlertDialog
        open={removing != null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
          }
        }}
      >
        <AlertDialogContent data-testid="spot-check-remove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("classificationSuggestions.report.removeTitle", {
                count: removing?.files.length ?? 1,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("classificationSuggestions.report.removeDescription", {
                category: removing?.category ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("button.cancel", { ns: "common" })}
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                const group = removing;
                setRemoving(null);
                if (group) {
                  void decide(group, false);
                }
              }}
            >
              {t("classificationSuggestions.report.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

type AcceptanceTableProps = {
  testId: string;
  title: string;
  /** One line saying what the table counts, in plain words. */
  description: string;
  firstColumn: string;
  rows: Record<string, Acceptance | ClassAcceptance>;
  acceptedHeader?: string;
  changedHeader?: string;
  autoHeader?: string;
  bulkHeader?: string | undefined;
};

function AcceptanceTable({
  testId,
  title,
  description,
  firstColumn,
  rows,
  acceptedHeader,
  changedHeader,
  autoHeader,
  bulkHeader,
}: Readonly<AcceptanceTableProps>) {
  const { t } = useTranslation(["fork"]);
  const entries = Object.entries(rows);
  if (entries.length === 0) {
    return null;
  }
  return (
    <section data-testid={testId} className="flex flex-col gap-1">
      <Heading as="h4">{title}</Heading>
      <div className="text-sm text-secondary-foreground">{description}</div>
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
            {bulkHeader && <TableHead>{bulkHeader}</TableHead>}
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
              {bulkHeader && (
                <TableCell>
                  {"bulk_accepted" in stats ? (stats.bulk_accepted ?? 0) : 0}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
