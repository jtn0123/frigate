import { RouteSuspense } from "@/components/fork/RouteErrorBoundary";
import PageLoading from "@/components/navigation/PageLoading";
import ShareViewButton from "@/components/navigation/ShareViewButton";
import { useApi } from "@/api/fork/client";
import ErrorState from "@/components/fork/ErrorState";
import { lazy, useEffect, useMemo, useState } from "react";
import TimeAgo from "@/components/dynamic/TimeAgo";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isDesktop } from "react-device-detect";

import { wrapAsync } from "@/utils/promise";
import { cn } from "@/lib/utils";
import { phoneFixes, phoneTouch } from "@/lib/fork/phone";
import {
  LuActivity,
  LuCpu,
  LuHardDrive,
  LuHeartPulse,
  LuSearchCode,
} from "react-icons/lu";
import { FaVideo } from "react-icons/fa";

import { useHashState } from "@/hooks/use-overlay-state";
import { Toaster } from "@/components/ui/sonner";

import { useTranslation } from "react-i18next";

import { isForkEnabled } from "@/fork/flags";

const GeneralMetrics = lazy(() => import("@/views/system/GeneralMetrics"));

const StorageMetrics = lazy(() => import("@/views/system/StorageMetrics"));

const CameraMetrics = lazy(() => import("@/views/system/CameraMetrics"));

const EnrichmentMetrics = lazy(
  () => import("@/views/system/EnrichmentMetrics"),
);

const AIModelMetrics = lazy(() => import("@/views/system/AIModelMetrics"));

const CameraHealthView = lazy(() => import("@/views/fork/CameraHealthView"));

const allMetrics = [
  "general",
  "enrichments",
  "models",
  "storage",
  "cameras",
  "health",
] as const;
type SystemMetric = (typeof allMetrics)[number];
function isSystemMetric(value: string): value is SystemMetric {
  const metricNames: readonly string[] = allMetrics;
  return metricNames.includes(value);
}

function System() {
  const { t } = useTranslation(["views/system"]);
  const { data: config } = useApi("/config", {
    revalidateOnFocus: false,
  });

  const metrics = useMemo(() => {
    const metrics = [...allMetrics];

    if (
      !config?.semantic_search.enabled &&
      !config?.lpr.enabled &&
      !config?.face_recognition.enabled
    ) {
      const index = metrics.indexOf("enrichments");
      metrics.splice(index, 1);
    }

    if (!isForkEnabled("cameraHealth")) {
      metrics.splice(metrics.indexOf("health"), 1);
    }

    return metrics;
  }, [config]);

  // stats page

  const [hashPage, setPage] = useHashState<SystemMetric>();
  const page = hashPage && metrics.includes(hashPage) ? hashPage : "general";
  const [lastUpdated, setLastUpdated] = useState<number>(0);

  useEffect(() => {
    document.title = t("documentTitle." + page);
  }, [page, t]);

  // stats collection

  const {
    data: statsSnapshot,
    error: statsError,
    mutate: refreshStats,
  } = useApi("/stats", {
    revalidateOnFocus: false,
  });

  return (
    <div className="flex size-full flex-col p-2">
      <Toaster position="top-center" />
      {/* fork: shrink-0, on a phone the column squeezed this header back to
          min-h-11 and its wrapped second row drew over the title below */}
      <div className="relative flex min-h-11 w-full shrink-0 flex-wrap items-center justify-between gap-1">
        <ToggleGroup
          className={cn(
            "*:rounded-md *:px-3 *:py-4",
            phoneTouch && "*:min-h-11",
          )}
          type="single"
          size="sm"
          value={page}
          onValueChange={(value) => {
            if (isSystemMetric(value)) {
              setPage(value);
            }
          }} // don't allow the severity to be unselected
        >
          {Object.values(metrics).map((item) => (
            <ToggleGroupItem
              key={item}
              className={`flex items-center justify-between gap-2 ${page == item ? "" : "*:text-muted-foreground"}`}
              value={item}
              aria-label={t("selectTab", { tab: t(item + ".title") })}
            >
              {item == "general" && <LuActivity className="size-4" />}
              {item == "enrichments" && <LuSearchCode className="size-4" />}
              {item == "models" && <LuCpu className="size-4" />}
              {item == "storage" && <LuHardDrive className="size-4" />}
              {item == "cameras" && <FaVideo className="size-4" />}
              {item == "health" && <LuHeartPulse className="size-4" />}
              {/* fork: a phone names the open tab, the rest stay icons */}
              {(isDesktop || (phoneFixes && page == item)) && (
                <div className="smart-capitalize">{t(item + ".title")}</div>
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-3">
          <ShareViewButton />
          {page !== "health" && Boolean(lastUpdated) && (
            <div className="h-full content-center text-sm text-muted-foreground">
              {t("lastRefreshed")}
              <TimeAgo time={lastUpdated * 1000} dense />
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-end gap-2">
        <div className="h-full content-center font-medium">{t("title")}</div>
        {statsSnapshot && (
          <div className="h-full content-center text-sm text-muted-foreground">
            {statsSnapshot.service.version}
          </div>
        )}
      </div>
      {statsError && (
        <ErrorState
          compact
          className="mt-2"
          error={statsError}
          onRetry={wrapAsync(() => refreshStats())}
        />
      )}
      <RouteSuspense fallback={<PageLoading />}>
        {page === "general" && (
          <div className="contents">
            <GeneralMetrics
              lastUpdated={lastUpdated}
              setLastUpdated={setLastUpdated}
              isActive
            />
          </div>
        )}
        {metrics.includes("enrichments") && page === "enrichments" && (
          <div className="contents">
            <EnrichmentMetrics
              lastUpdated={lastUpdated}
              setLastUpdated={setLastUpdated}
              isActive
            />
          </div>
        )}
        {page === "storage" && (
          <div className="contents">
            <StorageMetrics setLastUpdated={setLastUpdated} />
          </div>
        )}
        {page === "models" && (
          <div className="contents">
            <AIModelMetrics isActive setLastUpdated={setLastUpdated} />
          </div>
        )}
        {page === "cameras" && (
          <div className="contents">
            <CameraMetrics
              lastUpdated={lastUpdated}
              setLastUpdated={setLastUpdated}
              isActive
            />
          </div>
        )}
        {metrics.includes("health") && page === "health" && (
          <div className="contents">
            <CameraHealthView />
          </div>
        )}
      </RouteSuspense>
    </div>
  );
}

export default System;
