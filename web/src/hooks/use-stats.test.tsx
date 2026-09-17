import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIModelsResponse } from "@/types/aiModels";
import type { CameraStats, FrigateStats } from "@/types/stats";
import useStats from "./use-stats";

const mock = vi.hoisted(() => ({
  statsInterval: 60,
  isAdmin: false,
  models: undefined as AIModelsResponse | undefined,
}));

vi.mock("@/api/fork/client", () => ({
  useApi: () => ({
    data: {
      mqtt: { stats_interval: mock.statsInterval },
      cameras: { front: { enabled: true } },
    },
  }),
}));
vi.mock("swr", () => ({
  default: () => ({ data: mock.models, error: undefined }),
}));
vi.mock("@/api/ws", () => ({
  useFrigateStats: () => undefined,
  useJobStatus: () => ({ payload: undefined }),
}));
vi.mock("./use-is-admin", () => ({ useIsAdmin: () => mock.isAdmin }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const STALE = "models.readiness.stale";
const OFFLINE = "stats.cameraIsOffline";

/** Stats with one enabled camera that reports no frames. */
function statsAt(lastUpdated: number): FrigateStats {
  return {
    cameras: {
      front: { camera_fps: 0, pid: 1, ffmpeg_pid: 2 } as CameraStats,
    },
    cpu_usages: {},
    detectors: {},
    processes: {},
    service: {
      last_updated: lastUpdated,
      uptime: 1000,
      storage: {},
      latest_version: "0.17.0",
      version: "0.17.0",
    },
    camera_fps: 0,
    process_fps: 0,
    skipped_fps: 0,
    detection_fps: 0,
  };
}

function renderStats(stats: FrigateStats) {
  const { result } = renderHook(({ current }) => useStats(current), {
    initialProps: { current: stats },
  });
  return () => result.current.potentialProblems.map((problem) => problem.text);
}

function advanceSeconds(seconds: number) {
  act(() => {
    vi.advanceTimersByTime(seconds * 1000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
  mock.statsInterval = 60;
  mock.isAdmin = false;
  mock.models = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useStats stale stats", () => {
  it("keeps reporting offline cameras while the stats feed is stale", () => {
    const problems = renderStats(statsAt(Date.now() / 1000));
    expect(problems()).toEqual([OFFLINE]);

    advanceSeconds(100);

    expect(problems()).toEqual([STALE, OFFLINE]);
  });

  it("waits one and a half stats intervals before calling the feed stale", () => {
    mock.statsInterval = 300;
    const problems = renderStats(statsAt(Date.now() / 1000));

    advanceSeconds(200);
    expect(problems()).toEqual([OFFLINE]);

    advanceSeconds(260);
    expect(problems()).toEqual([STALE, OFFLINE]);
  });

  it("does not compare the server's clock with the browser's", () => {
    const aheadOfBrowser = renderStats(statsAt(Date.now() / 1000 + 60));
    expect(aheadOfBrowser()).toEqual([OFFLINE]);

    const behindBrowser = renderStats(statsAt(Date.now() / 1000 - 600));
    expect(behindBrowser()).toEqual([OFFLINE]);
  });
});

describe("useStats model server (UI88)", () => {
  const SERVER_UNAVAILABLE = "models.server.unavailable";

  function modelsWithServer(status: string): AIModelsResponse {
    return {
      updated: Date.now() / 1000,
      telemetry_status: "connected",
      server: { status, scopes: [] },
      models: [],
      audio: { status: "connected" },
      shared_gpus: {},
    };
  }

  beforeEach(() => {
    mock.isAdmin = true;
  });

  it("does not report the model server before ai/models has loaded", () => {
    const problems = renderStats(statsAt(Date.now() / 1000));
    expect(problems()).not.toContain(SERVER_UNAVAILABLE);
  });

  it("reports the model server once it is loaded and not connected", () => {
    mock.models = modelsWithServer("unavailable");
    const problems = renderStats(statsAt(Date.now() / 1000));
    expect(problems()).toContain(SERVER_UNAVAILABLE);
  });

  it("stays quiet while the loaded model server is connected", () => {
    mock.models = modelsWithServer("connected");
    const problems = renderStats(statsAt(Date.now() / 1000));
    expect(problems()).not.toContain(SERVER_UNAVAILABLE);
  });

  // fork (UI95): the panel calls a partial snapshot current, so the status
  // bar must not call the collector missing or stale
  it("does not call a partial snapshot missing or stale", () => {
    mock.models = modelsWithServer("partial");
    const problems = renderStats(statsAt(Date.now() / 1000));
    expect(problems()).not.toContain(SERVER_UNAVAILABLE);
  });
});
