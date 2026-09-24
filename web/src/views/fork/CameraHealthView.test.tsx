import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CameraHealthView from "./CameraHealthView";

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
});
