import { AIModelsResponse } from "@/types/aiModels";
import { FrigateConfig } from "@/types/frigateConfig";
import {
  CameraDetectThreshold,
  CameraFfmpegThreshold,
  InferenceThreshold,
} from "@/types/graph";
import { FrigateStats, PotentialProblem } from "@/types/stats";
import { useEffect, useState, useMemo } from "react";
import useSWR from "swr";
import useDeepMemo from "./use-deep-memo";
import { capitalizeAll, capitalizeFirstLetter } from "@/utils/stringUtil";
import { isReplayCamera } from "@/utils/cameraUtil";
import { useFrigateStats, useJobStatus } from "@/api/ws";
import { useIsAdmin } from "./use-is-admin";
import { isForkEnabled } from "@/fork/flags";
import { softwareDecodingCameras } from "@/lib/fork/camera-health";

import { useTranslation } from "react-i18next";

export default function useStats(stats: FrigateStats | undefined) {
  const { t } = useTranslation(["views/system"]);
  const { data: config } = useSWR<FrigateConfig>("config");
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
        color: "text-warning",
        relevantLink: "/system#models",
      });
    }
    if (isAdmin && models?.server?.status !== "connected") {
      problems.push({
        text: t("models.server.unavailable"),
        color: "text-warning",
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
        color: "text-warning",
        relevantLink: "/system#models",
      });
    }
    if (
      !memoizedStats ||
      !Number.isFinite(memoizedStats.service.last_updated) ||
      now / 1000 - memoizedStats.service.last_updated > 90 ||
      memoizedStats.service.last_updated > now / 1000 + 5
    ) {
      problems.push({
        text: t("models.readiness.stale"),
        color: "text-warning",
        relevantLink: "/system#health",
      });
      return problems;
    }

    // if frigate has just started
    // don't look for issues
    if (memoizedStats.service.uptime < 120) {
      return problems;
    }

    // check shm level
    const shm = memoizedStats.service.storage["/dev/shm"];
    if (shm?.total && shm?.min_shm && shm.total < shm.min_shm) {
      problems.push({
        text: t("stats.shmTooLow", {
          total: shm.total,
          min: shm.min_shm,
        }),
        color: "text-danger",
        relevantLink: "/system#storage",
      });
    }

    // check detectors for high inference speeds
    Object.entries(memoizedStats["detectors"]).forEach(([key, det]) => {
      if (det["inference_speed"] > InferenceThreshold.error) {
        problems.push({
          text: t("stats.detectIsVerySlow", {
            detect: capitalizeFirstLetter(key),
            speed: det["inference_speed"],
          }),
          color: "text-danger",
          relevantLink: "/system#general",
        });
      } else if (det["inference_speed"] > InferenceThreshold.warning) {
        problems.push({
          text: t("stats.detectIsSlow", {
            detect: capitalizeFirstLetter(key),
            speed: det["inference_speed"],
          }),
          color: "text-orange-400",
          relevantLink: "/system#general",
        });
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
        problems.push({
          text: t("stats.cameraIsOffline", {
            camera: capitalizeFirstLetter(capitalizeAll(cameraName)),
          }),
          color: "text-danger",
          relevantLink: "logs",
        });
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
          color: "text-orange-400",
          relevantLink: "/system#health",
        });
      });
    }

    // check camera cpu usages
    Object.entries(memoizedStats["cameras"]).forEach(([name, cam]) => {
      // Skip replay cameras
      if (isReplayCamera(name)) {
        return;
      }

      const ffmpegAvg = Number.parseFloat(
        memoizedStats["cpu_usages"][cam["ffmpeg_pid"]]?.cpu_average,
      );
      const detectAvg = Number.parseFloat(
        memoizedStats["cpu_usages"][cam["pid"]]?.cpu_average,
      );

      const cameraName = config?.cameras?.[name]?.friendly_name ?? name;

      if (
        !Number.isNaN(ffmpegAvg) &&
        ffmpegAvg >= CameraFfmpegThreshold.error
      ) {
        problems.push({
          text: t("stats.ffmpegHighCpuUsage", {
            camera: capitalizeFirstLetter(capitalizeAll(cameraName)),
            ffmpegAvg,
          }),
          color: "text-danger",
          relevantLink: "/system#cameras",
        });
      }

      if (
        !Number.isNaN(detectAvg) &&
        detectAvg >= CameraDetectThreshold.error
      ) {
        problems.push({
          text: t("stats.detectHighCpuUsage", {
            camera: capitalizeFirstLetter(capitalizeAll(cameraName)),
            detectAvg,
          }),
          color: "text-danger",
          relevantLink: "/system#cameras",
        });
      }
    });

    // Add message if debug replay is active
    if (replayActive) {
      problems.push({
        text: t("stats.debugReplayActive", {
          defaultValue: "Debug replay session is active",
        }),
        color: "text-selected",
        relevantLink: "/replay",
      });
    }

    return problems;
  }, [
    config,
    memoizedStats,
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
  const { data: initialStats } = useSWR<FrigateStats>("stats", {
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
