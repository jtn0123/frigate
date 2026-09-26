import { AIModelsResponse } from "@/types/aiModels";
import { InferenceThreshold } from "@/types/graph";
import { FrigateStats, PotentialProblem, ProblemSeverity } from "@/types/stats";
import { useMemo, useState, useEffect } from "react";
import useSWR from "swr";
import { useApi } from "@/api/fork/client";
import useDeepMemo from "./use-deep-memo";
import { capitalizeAll, capitalizeFirstLetter } from "@/utils/stringUtil";
import { formatDetectorName } from "@/lib/fork/detector-name";
import { isReplayCamera } from "@/utils/cameraUtil";
import { useFrigateStats, useJobStatus } from "@/api/ws";
import { useIsAdmin } from "./use-is-admin";
import { isForkEnabled } from "@/fork/flags";
import { softwareDecodingCameras } from "@/lib/fork/camera-health";
import { isStatsStale } from "@/lib/fork/stats-staleness";

import { useTranslation } from "react-i18next";

function problem(
  severity: ProblemSeverity,
  text: string,
  relevantLink?: string,
): PotentialProblem {
  return { text, severity, relevantLink };
}

// matches SKIPPED_DETECTIONS_PCT in frigate/stats/emitter.py
const SKIPPED_DETECTIONS_PCT = 5;

export default function useStats(stats: FrigateStats | undefined) {
  const { t } = useTranslation(["views/system"]);
  const { data: config } = useApi("/config");
  const isAdmin = useIsAdmin();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const { data: models, error: modelError } = useSWR<AIModelsResponse, unknown>(
    isAdmin ? "ai/models" : null,
    { refreshInterval: 10000 },
  );

  // Pass isAdmin as revalidateOnFocus so non-admins never send the jobState snapshot pull
  const { payload: replayJob } = useJobStatus("debug_replay", isAdmin);
  const replayActive = Boolean(
    isAdmin &&
    replayJob &&
    (replayJob.status === "queued" ||
      replayJob.status === "running" ||
      replayJob.status === "success"),
  );

  const memoizedStats = useDeepMemo(stats);
  // fork (UI68): when these stats reached the browser
  const statsReceivedAt = useMemo(
    () => (memoizedStats ? Date.now() : undefined),
    [memoizedStats],
  );

  const potentialProblems = useMemo<PotentialProblem[]>(() => {
    const problems: PotentialProblem[] = [];

    if (
      isAdmin &&
      (modelError ||
        !models ||
        now / 1000 - models.updated > 90 ||
        models.telemetry_status !== "connected" ||
        models.audio.status !== "connected" ||
        models.audio.pause_reason ||
        models.models.some((model) =>
          ["stale", "missing", "unavailable"].includes(model.status),
        ))
    ) {
      problems.push({
        text: t("models.readiness.attention"),
        severity: "warning",
        relevantLink: "/system#models",
      });
    }
    // fork (UI88): only once ai/models has loaded; the readiness check above
    // already covers a failed or pending fetch
    // fork (UI95): "partial" means some containers could not be measured; the
    // collector is there and the scopes it lists are current, so the status
    // bar stays quiet, as the panel does
    if (
      isAdmin &&
      models &&
      models.server?.status !== "connected" &&
      models.server?.status !== "partial"
    ) {
      problems.push({
        text: t("models.server.unavailable"),
        severity: "warning",
        relevantLink: "/system#models",
      });
    }
    if (
      isAdmin &&
      models?.server?.scopes.some(
        (scope) => scope.memory_pressure != null && scope.memory_pressure > 1,
      )
    ) {
      problems.push({
        text: t("models.server.pressureWarning"),
        severity: "warning",
        relevantLink: "/system#models",
      });
    }
    // fork (UI68): staleness counts from the last message's arrival, so it
    // follows stats_interval and ignores clock skew, and the checks below
    // still run on the last stats received
    if (
      !memoizedStats ||
      !Number.isFinite(memoizedStats.service.last_updated) ||
      isStatsStale(statsReceivedAt, now, config?.mqtt.stats_interval)
    ) {
      problems.push({
        text: t("models.readiness.stale"),
        severity: "warning",
        relevantLink: "/system#health",
      });
    }
    if (!memoizedStats) {
      return problems;
    }

    // if frigate has just started
    // don't look for issues
    if (memoizedStats.service.uptime < 120) {
      return problems;
    }

    if (memoizedStats.service.retention_unmet) {
      problems.push(
        problem("error", t("stats.retentionUnmet"), "/system#storage"),
      );
    }

    // check detectors for high inference speeds
    Object.entries(memoizedStats["detectors"]).forEach(([key, det]) => {
      if (det["inference_speed"] > InferenceThreshold.error) {
        problems.push(
          problem(
            "error",
            t("stats.detectIsVerySlow", {
              detect: formatDetectorName(key),
              speed: det["inference_speed"],
            }),
            "/system#general",
          ),
        );
      } else if (det["inference_speed"] > InferenceThreshold.warning) {
        problems.push(
          problem(
            "warning",
            t("stats.detectIsSlow", {
              detect: formatDetectorName(key),
              speed: det["inference_speed"],
            }),
            "/system#general",
          ),
        );
      }
    });

    // check for offline cameras
    Object.entries(memoizedStats["cameras"]).forEach(([name, cam]) => {
      if (!config) {
        return;
      }

      // Skip replay cameras
      if (isReplayCamera(name)) {
        return;
      }

      const cameraName = config.cameras?.[name]?.friendly_name ?? name;
      if (config.cameras?.[name]?.enabled && cam["camera_fps"] == 0) {
        problems.push(
          problem(
            "error",
            t("stats.cameraIsOffline", {
              camera: capitalizeFirstLetter(capitalizeAll(cameraName)),
            }),
            "logs",
          ),
        );
      }
    });

    // fork (D10, D14): cameras that switched to software decoding in the last day
    if (isForkEnabled("cameraHealth")) {
      softwareDecodingCameras(
        memoizedStats,
        memoizedStats.service.last_updated,
      ).forEach((name) => {
        const cameraName = config?.cameras?.[name]?.friendly_name ?? name;
        problems.push({
          text: t("cameraHealth.softwareDecodingProblem", {
            ns: "fork",
            camera: capitalizeFirstLetter(capitalizeAll(cameraName)),
          }),
          severity: "warning",
          relevantLink: "/system#health",
        });
      });
    }

    // check for skipped detections
    Object.entries(memoizedStats["cameras"]).forEach(([name, cam]) => {
      // Skip replay cameras
      if (isReplayCamera(name)) {
        return;
      }

      const cameraName = config?.cameras?.[name]?.friendly_name ?? name;

      if (
        config?.cameras?.[name]?.enabled &&
        cam["skipped_pct"] >= SKIPPED_DETECTIONS_PCT
      ) {
        problems.push(
          problem(
            "warning",
            t("stats.cameraSkippedDetections", {
              camera: capitalizeFirstLetter(capitalizeAll(cameraName)),
              pct: cam["skipped_pct"],
            }),
            "/system#cameras",
          ),
        );
      }
    });

    // Add message if debug replay is active
    if (replayActive) {
      problems.push(
        problem(
          "info",
          t("stats.debugReplayActive", {
            defaultValue: "Debug replay session is active",
          }),
          "/replay",
        ),
      );
    }

    return problems;
  }, [
    config,
    memoizedStats,
    statsReceivedAt,
    t,
    replayActive,
    isAdmin,
    models,
    modelError,
    now,
  ]);

  return { potentialProblems };
}

export function useAutoFrigateStats() {
  const { data: initialStats } = useApi("/stats", {
    revalidateOnFocus: false,
  });
  const latestStats = useFrigateStats();

  const stats = useMemo(() => {
    if (latestStats) {
      return latestStats;
    }

    return initialStats;
  }, [initialStats, latestStats]);

  return stats;
}
