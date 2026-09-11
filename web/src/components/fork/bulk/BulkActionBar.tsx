/**
 * Fork: floating action bar for Explore's selection mode.
 *
 * Idle it is a single "Select" button that enters selection mode. Once the
 * mode is on or anything is selected it shows the count, Select all,
 * Submit to Frigate+ (when enabled and the selection has unsubmitted
 * snapshots), Delete (admins, with confirmation) and Cancel.
 */

import { useCallback, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import axios from "axios";
import useSWR from "swr";
import { toast } from "sonner";
import { HiTrash } from "react-icons/hi";
import { LuCheck, LuSquareCheck, LuX } from "react-icons/lu";
import FrigatePlusIcon from "@/components/icons/FrigatePlusIcon";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { useIsAdmin } from "@/hooks/use-is-admin";
import type { BulkSelection } from "@/hooks/fork/use-bulk-selection";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { SearchResult } from "@/types/search";
import { cn } from "@/lib/utils";

type BulkActionBarProps = {
  bulk: BulkSelection<SearchResult>;
  /** Called after a mutation so the view can refetch. */
  onChanged: () => void;
  className?: string;
};

type ApiError = {
  response?: { data?: { message?: string; detail?: string } };
};

export default function BulkActionBar({
  bulk,
  onChanged,
  className,
}: BulkActionBarProps) {
  const { t } = useTranslation(["fork", "components/filter", "common"]);
  const { data: config } = useSWR<FrigateConfig>("config");
  const isAdmin = useIsAdmin();
  const [confirm, setConfirm] = useState<"delete" | "plus" | null>(null);
  const [busy, setBusy] = useState(false);

  const count = bulk.selectedIds.length;
  const plusEligible = useMemo(
    () =>
      config?.plus?.enabled
        ? bulk.selectedItems.filter(
            (item) =>
              item.has_snapshot &&
              !item.plus_id &&
              item.data?.type === "object",
          )
        : [],
    [config, bulk.selectedItems],
  );

  const exit = useCallback(() => {
    bulk.clear();
    bulk.setActive(false);
  }, [bulk]);

  const onDelete = useCallback(async () => {
    setBusy(true);
    try {
      const resp = await axios.delete("events/", {
        data: { event_ids: bulk.selectedIds },
      });
      if (resp.status === 200) {
        toast.success(
          t("trackedObjectDelete.toast.success", { ns: "components/filter" }),
          { position: "top-center" },
        );
        exit();
        onChanged();
      }
    } catch (error) {
      const data = (error as ApiError).response?.data;
      const errorMessage = data?.message || data?.detail || "Unknown error";
      toast.error(
        t("trackedObjectDelete.toast.error", {
          ns: "components/filter",
          errorMessage,
        }),
        { position: "top-center" },
      );
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }, [bulk.selectedIds, exit, onChanged, t]);

  const onSubmitToPlus = useCallback(async () => {
    setBusy(true);
    const results = await Promise.allSettled(
      plusEligible.map((item) =>
        axios.post(`events/${item.id}/plus`, { include_annotation: 1 }),
      ),
    );
    const failed = results.filter(
      (result) =>
        result.status === "rejected" ||
        result.value.status !== 200 ||
        !result.value.data?.success,
    ).length;
    const submitted = results.length - failed;
    if (submitted > 0) {
      toast.success(t("bulk.plus.submitted", { count: submitted }), {
        position: "top-center",
      });
    }
    if (failed > 0) {
      toast.error(t("bulk.plus.failed", { count: failed }), {
        position: "top-center",
      });
    }
    setBusy(false);
    setConfirm(null);
    exit();
    onChanged();
  }, [plusEligible, exit, onChanged, t]);

  if (!bulk.enabled || bulk.items.length === 0) {
    return null;
  }

  const showBar = bulk.active || count > 0;

  return (
    <>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "plus"
                ? t("bulk.plus.title")
                : t("trackedObjectDelete.title", { ns: "components/filter" })}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogDescription>
            {confirm === "plus" ? (
              t("bulk.plus.description", { count: plusEligible.length })
            ) : (
              <Trans ns="components/filter" values={{ objectLength: count }}>
                trackedObjectDelete.desc
              </Trans>
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("button.cancel", { ns: "common" })}
            </AlertDialogCancel>
            <AlertDialogAction
              className={
                confirm === "plus"
                  ? undefined
                  : buttonVariants({ variant: "destructive" })
              }
              disabled={busy}
              data-testid="bulk-confirm"
              onClick={(event) => {
                event.preventDefault();
                if (confirm === "plus") {
                  onSubmitToPlus();
                } else {
                  onDelete();
                }
              }}
            >
              {confirm === "plus"
                ? t("bulk.plus.confirm")
                : t("button.delete", { ns: "common" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div
        className={cn(
          "pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-2 md:bottom-6",
          className,
        )}
      >
        {showBar ? (
          <div
            role="toolbar"
            aria-label={t("bulk.toolbarLabel")}
            data-testid="bulk-action-bar"
            className="pointer-events-auto flex max-w-full items-center gap-1 rounded-full border border-secondary bg-background/95 px-2 py-1 text-sm shadow-lg backdrop-blur md:gap-2 md:px-3"
          >
            <span
              className="px-2 font-medium text-primary"
              data-testid="bulk-count"
            >
              {t("bulk.selected", { count })}
            </span>
            {count < bulk.items.length && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("bulk.selectAll")}
                data-testid="bulk-select-all"
                onClick={bulk.selectAll}
              >
                <LuCheck className="size-4" />
                <span className="hidden md:inline">{t("bulk.selectAll")}</span>
              </Button>
            )}
            {plusEligible.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("bulk.plus.action")}
                data-testid="bulk-plus"
                onClick={() => setConfirm("plus")}
              >
                <FrigatePlusIcon className="size-4" />
                <span className="hidden md:inline">
                  {t("bulk.plus.action")}
                </span>
              </Button>
            )}
            {isAdmin && count > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                aria-label={t("button.delete", { ns: "common" })}
                data-testid="bulk-delete"
                onClick={() => setConfirm("delete")}
              >
                <HiTrash className="size-4" />
                <span className="hidden md:inline">
                  {t("button.delete", { ns: "common" })}
                </span>
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("button.cancel", { ns: "common" })}
              data-testid="bulk-cancel"
              onClick={exit}
            >
              <LuX className="size-4" />
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="pointer-events-auto gap-2 rounded-full shadow-lg"
            data-testid="bulk-select"
            onClick={() => bulk.setActive(true)}
          >
            <LuSquareCheck className="size-4" />
            {t("bulk.select")}
          </Button>
        )}
      </div>
    </>
  );
}
