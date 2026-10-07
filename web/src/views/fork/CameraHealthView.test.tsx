import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CameraHealthView from "./CameraHealthView";
import type { CameraRecordingHistory } from "@/types/fork/cameraHistory";

const fixture = vi.hoisted(() => ({
  params: new URLSearchParams(),
  update: vi.fn(),
  mutate: vi.fn(),
  refresh: vi.fn(),
  config: undefined as unknown,
  configError: undefined as unknown,
  history: undefined as unknown,
  historyError: undefined as unknown,
  stats: undefined as unknown,
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("@/hooks/use-view-query", () => ({
  useViewQuery: () => [fixture.params, fixture.update],
}));
vi.mock("@/api/fork/client", () => ({
  useApi: () => ({
    data: fixture.config,
    error: fixture.configError,
    mutate: fixture.mutate,
  }),
}));
vi.mock("@/hooks/use-stats", () => ({
  useAutoFrigateStats: () => fixture.stats,
}));
vi.mock("@/hooks/fork/use-camera-history", () => ({
  useCameraHistory: () => ({
    data: fixture.history,
    error: fixture.historyError,
    refresh: fixture.refresh,
  }),
}));
vi.mock("@/hooks/fork/use-cameras-enabled", () => ({
  useCamerasEnabled: () => ({}),
}));
vi.mock("@/hooks/use-camera-friendly-name", () => ({
  resolveCameraName: (_config: unknown, camera: { name: string }) =>
    camera.name,
}));
vi.mock("@/components/fork/ErrorState", () => ({
  default: ({ onRetry }: { onRetry: () => void }) => (
    <button onClick={onRetry}>Retry request</button>
  ),
}));
vi.mock("@/components/fork/CameraHealthDrawer", () => ({
  default: ({
    row,
    onStep,
    onClose,
  }: {
    row?: { camera: string };
    onStep: (delta: number) => void;
    onClose: () => void;
  }) => (
    <div data-testid="drawer" data-camera={row?.camera}>
      <button onClick={() => onStep(1)}>Next camera</button>
      <button onClick={onClose}>Close camera</button>
    </div>
  ),
}));
vi.mock("@/components/fork/Sparkline", () => ({
  default: () => <div data-testid="sparkline" />,
}));

const camera = (name: string, order: number) => ({
  name,
  enabled: true,
  enabled_in_config: true,
  ui: { order },
});
const series = (uptime: number, downtime: number) => ({
  uptime,
  downtime,
  samples: 1,
  expected_fps: 10,
  fps: [10],
  states: ["ok"],
  incidents: [],
});

const recording = (
  overrides: Partial<CameraRecordingHistory> = {},
): CameraRecordingHistory => ({
  status: "ok",
  coverage_percent: 100,
  analyzed_seconds: 600,
  requested_seconds: 3600,
  missing_seconds: 0,
  gap_count: 0,
  longest_gap_seconds: 0,
  mature_before: 190,
  latest_analyzed_end: 190,
  ...overrides,
});

function setRecording(name: string, value: CameraRecordingHistory | undefined) {
  const history = fixture.history as {
    cameras: Partial<
      Record<
        string,
        ReturnType<typeof series> & { recording?: CameraRecordingHistory }
      >
    >;
  };
  const cameraHistory = history.cameras[name];
  if (!cameraHistory) throw new Error(`Missing camera fixture: ${name}`);
  if (value === undefined) {
    delete cameraHistory.recording;
  } else {
    cameraHistory.recording = value;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.params = new URLSearchParams();
  fixture.configError = undefined;
  fixture.historyError = undefined;
  fixture.config = {
    cameras: {
      garden: camera("garden", 1),
      porch: camera("porch", 2),
      hidden: { ...camera("hidden", 3), enabled_in_config: false },
    },
  };
  fixture.history = {
    start: 100,
    end: 200,
    cell_seconds: 5,
    cameras: {
      garden: series(100, 0),
      porch: series(90, 600),
    },
  };
  fixture.stats = {
    service: { last_updated: Date.now() / 1000, uptime: 1000 },
    cameras: {
      garden: {
        camera_fps: 10,
        expected_fps: 10,
        skipped_fps: 0,
        detection_fps: 5,
      },
      porch: {
        camera_fps: 0,
        expected_fps: 10,
        skipped_fps: 0,
        detection_fps: 0,
      },
    },
  };
});

describe("CameraHealthView", () => {
  it("shows configured cameras worst first and narrows to attention", () => {
    render(<CameraHealthView />);
    expect(
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.getAttribute("data-testid")),
    ).toEqual(["camera-health-porch", "camera-health-garden"]);
    expect(
      screen.queryByTestId("camera-health-hidden"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("camera-health-summary")).toHaveAttribute(
      "data-attention",
      "1",
    );
    fireEvent.click(screen.getByText(/cameraHealth.scope.attention/));
    expect(fixture.update).toHaveBeenCalledWith({ scope: "attention" });
  });

  it("sorts the table and steps through cameras in the drawer", () => {
    fixture.params = new URLSearchParams("health=garden");
    render(<CameraHealthView />);
    expect(screen.getByTestId("drawer")).toHaveAttribute(
      "data-camera",
      "garden",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /cameraHealth.table.sort.*cameraHealth.table.camera/,
      }),
    );
    expect(screen.getAllByRole("row")[1]).toHaveAttribute(
      "data-testid",
      "camera-health-garden",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next camera" }));
    expect(fixture.update).toHaveBeenCalledWith({ health: "porch" });
    fireEvent.click(screen.getByRole("button", { name: "Close camera" }));
    expect(fixture.update).toHaveBeenCalledWith({ health: null });
  });

  it("shows stale data and retries both failed requests", () => {
    fixture.stats = {
      service: { last_updated: Date.now() / 1000 - 200, uptime: 1000 },
      cameras: {},
    };
    fixture.configError = new Error("config failed");
    fixture.historyError = new Error("history failed");
    render(<CameraHealthView />);
    expect(screen.getByText(/models\.readiness\.stale/)).toBeInTheDocument();
    expect(screen.getByTestId("camera-health-garden")).toHaveTextContent(
      "cameraHealth.state.unknown",
    );
    const retries = screen.getAllByRole("button", { name: "Retry request" });
    expect(retries).toHaveLength(2);
    fireEvent.click(retries[0] as HTMLElement);
    fireEvent.click(retries[1] as HTMLElement);
    expect(fixture.mutate).toHaveBeenCalledTimes(1);
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
  });

  it("flags 50% recording coverage independently of healthy capture", () => {
    setRecording(
      "garden",
      recording({
        status: "gaps",
        coverage_percent: 50,
        missing_seconds: 300,
        gap_count: 1,
        longest_gap_seconds: 300,
      }),
    );
    fixture.params = new URLSearchParams("scope=attention");
    render(<CameraHealthView />);
    const garden = screen.getByTestId("camera-health-garden");
    expect(garden).toHaveAttribute("data-state", "ok");
    expect(garden).toHaveTextContent("cameraHealth.state.ok");
    const coverage = within(garden).getByTestId("camera-health-recording");
    expect(coverage).toHaveAttribute("data-recording-status", "gaps");
    expect(coverage).toHaveTextContent('cameraHealth.percent {"value":"50"}');
    expect(coverage).toHaveTextContent("cameraHealth.recording.status.gaps");
    // The attention filter includes recording gaps, but capture health and
    // incident counters still describe their original data sources.
    expect(screen.getByText(/cameraHealth.scope.attention/)).toHaveTextContent(
      '"value":2',
    );
    expect(screen.getByTestId("camera-health-summary")).toHaveAttribute(
      "data-attention",
      "2",
    );
    expect(screen.getByTestId("camera-health-summary")).toHaveTextContent(
      'cameraHealth.recording.summary {"count":1}',
    );
    expect(
      within(garden).getByTestId("camera-health-issues"),
    ).toHaveTextContent("cameraHealth.table.clean");
  });

  it.each([
    [undefined, "unknown"],
    [recording({ status: "unknown", coverage_percent: null }), "unknown"],
    [recording({ analyzed_seconds: 0 }), "unknown"],
    [recording({ status: "disabled" }), "disabled"],
    [recording({ status: "not_continuous" }), "not_continuous"],
  ] as const)(
    "shows unavailable or inapplicable coverage without a percent (%s)",
    (value, status) => {
      setRecording("garden", value);
      render(<CameraHealthView />);
      const garden = screen.getByTestId("camera-health-garden");
      expect(garden).toHaveAttribute("data-state", "ok");
      const coverage = within(garden).getByTestId("camera-health-recording");
      expect(coverage).toHaveAttribute("data-recording-status", status);
      expect(coverage).toHaveTextContent(
        `cameraHealth.recording.status.${status}`,
      );
      expect(coverage).not.toHaveTextContent("cameraHealth.percent");
    },
  );

  it("sorts recording coverage without changing capture ordering semantics", () => {
    setRecording("garden", recording({ coverage_percent: 50 }));
    setRecording("porch", recording());
    render(<CameraHealthView />);
    const sort = screen.getByRole("button", {
      name: /cameraHealth.table.sort.*cameraHealth.table.recording/,
    });
    fireEvent.click(sort);
    expect(screen.getAllByRole("row")[1]).toHaveAttribute(
      "data-testid",
      "camera-health-garden",
    );
    expect(sort.closest("th")).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(sort);
    expect(screen.getAllByRole("row")[1]).toHaveAttribute(
      "data-testid",
      "camera-health-porch",
    );
    expect(sort.closest("th")).toHaveAttribute("aria-sort", "descending");
  });

  it("shows the observed duration beside 100% coverage for a partially assessed range", () => {
    setRecording(
      "garden",
      recording({ analyzed_seconds: 600, requested_seconds: 3600 }),
    );
    render(<CameraHealthView />);
    const coverage = within(
      screen.getByTestId("camera-health-garden"),
    ).getByTestId("camera-health-recording");
    expect(coverage).toHaveTextContent('cameraHealth.percent {"value":"100"}');
    expect(coverage).toHaveTextContent(
      `cameraHealth.recording.checkedDuration ${JSON.stringify({
        duration: 'time.m {"ns":"common","time":10}',
      })}`,
    );
    expect(coverage).toHaveAttribute("data-recording-status", "ok");
  });
});
