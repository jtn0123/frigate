import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import CameraHealthDrawer from "./CameraHealthDrawer";
import type { HealthRow } from "@/lib/fork/camera-history";
import type { CameraRecordingHistory } from "@/types/fork/cameraHistory";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("@/hooks/fork/use-metric-time", () => ({
  useMetricTimeFormatter: () => (time: number) => `time:${time}`,
}));
vi.mock("@/components/fork/CameraSourceState", () => ({ default: () => null }));

const recording = (
  overrides: Partial<CameraRecordingHistory> = {},
): CameraRecordingHistory => ({
  status: "gaps",
  coverage_percent: 50,
  analyzed_seconds: 600,
  requested_seconds: 3600,
  missing_seconds: 300,
  gap_count: 2,
  longest_gap_seconds: 240,
  mature_before: 200,
  latest_analyzed_end: 190,
  ...overrides,
});

function show(data: CameraRecordingHistory | undefined) {
  const row: HealthRow = {
    camera: "side_yard",
    label: "Side Yard",
    state: "ok",
    reasons: [],
    notes: [],
    stats: undefined,
    fps: 5,
    expectedFps: 5,
    share: undefined,
    uptime: 100,
    downtime: 0,
    issues: {
      offlineSeconds: 0,
      outages: 0,
      restarts: 0,
      stalls: 0,
      reconnects: 0,
    },
    series: {
      uptime: 100,
      downtime: 0,
      samples: 1,
      expected_fps: 5,
      fps: [5],
      states: ["ok"],
      incidents: [],
      ...(data === undefined ? {} : { recording: data }),
    },
  };
  return render(
    <MemoryRouter>
      <CameraHealthDrawer
        row={row}
        index={0}
        total={1}
        range="1h"
        start={0}
        end={3600}
        cellSeconds={150}
        onClose={vi.fn()}
        onStep={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe("CameraHealthDrawer recording coverage", () => {
  it("shows missing footage and assessment limits beside healthy capture", () => {
    show(recording());
    expect(screen.getByText("cameraHealth.state.ok")).toBeInTheDocument();
    const details = screen.getByTestId("camera-health-recording-details");
    expect(details).toHaveAccessibleName("cameraHealth.recording.title");
    expect(details).toHaveAttribute("data-recording-status", "gaps");
    expect(details).toHaveTextContent('cameraHealth.percent {"value":"50"}');
    expect(within(details).getByTestId("recording-missing")).toHaveTextContent(
      'time.minute_other {"ns":"common","time":5}',
    );
    expect(
      within(details).getByTestId("recording-longestGap"),
    ).toHaveTextContent('time.minute_other {"ns":"common","time":4}');
    expect(within(details).getByTestId("recording-gaps")).toHaveTextContent(
      "2",
    );
    expect(within(details).getByTestId("recording-analyzed")).toHaveTextContent(
      'time.minute_other {"ns":"common","time":10}',
    );
    expect(
      within(details).getByTestId("recording-requested"),
    ).toHaveTextContent('time.hour_one {"ns":"common","time":1}');
    expect(
      within(details).getByTestId("recording-checkedThrough"),
    ).toHaveTextContent("time:190");
    expect(details).toHaveTextContent("cameraHealth.recording.pending");
    expect(details).toHaveTextContent("cameraHealth.recording.scope");
    expect(details).toHaveTextContent("cameraHealth.recording.basis");
    expect(
      screen.getByTestId("camera-health-no-incidents"),
    ).toBeInTheDocument();
  });

  it.each([
    undefined,
    recording({
      status: "unknown",
      coverage_percent: null,
      latest_analyzed_end: null,
    }),
    recording({
      coverage_percent: 100,
      analyzed_seconds: 0,
      latest_analyzed_end: null,
    }),
  ])(
    "shows unavailable analysis without inventing 100%% coverage (%s)",
    (data) => {
      show(data);
      const details = screen.getByTestId("camera-health-recording-details");
      expect(details).toHaveAttribute("data-recording-status", "unknown");
      expect(details).toHaveTextContent("cameraHealth.recording.unavailable");
      expect(details).not.toHaveTextContent("cameraHealth.percent");
      expect(
        within(details).getByTestId("recording-missing"),
      ).toHaveTextContent("cameraHealth.recording.status.unknown");
      expect(
        within(details).getByTestId("recording-checkedThrough"),
      ).toHaveTextContent("cameraHealth.recording.status.unknown");
    },
  );

  it.each([
    ["disabled", "disabled"],
    ["not_continuous", "notContinuous"],
  ] as const)(
    "explains %s without presenting it as recording loss",
    (status, explanation) => {
      show(recording({ status }));
      const details = screen.getByTestId("camera-health-recording-details");
      expect(details).toHaveAttribute("data-recording-status", status);
      expect(details).toHaveTextContent(
        `cameraHealth.recording.${explanation}`,
      );
      expect(details).not.toHaveTextContent(
        "cameraHealth.recording.status.gaps",
      );
      expect(details).not.toHaveTextContent("cameraHealth.percent");
      expect(
        within(details).queryByTestId("recording-missing"),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps a full requested week readable as days and distinguishes it from analyzed time", () => {
    show(recording({ requested_seconds: 604800, analyzed_seconds: 90 }));
    expect(screen.getByTestId("recording-requested")).toHaveTextContent(
      'time.day_other {"ns":"common","time":7}',
    );
    expect(screen.getByTestId("recording-analyzed")).toHaveTextContent(
      'time.minute_one {"ns":"common","time":1} time.second_other {"ns":"common","time":30}',
    );
  });

  it("preserves explicit zero loss and singular duration labels", () => {
    show(
      recording({
        status: "ok",
        coverage_percent: 100,
        missing_seconds: 0,
        longest_gap_seconds: 0,
        gap_count: 0,
        analyzed_seconds: 1,
      }),
    );
    expect(screen.getByTestId("recording-missing")).toHaveTextContent(
      'cameraHealth.recording.seconds {"count":0}',
    );
    expect(screen.getByTestId("recording-longestGap")).toHaveTextContent(
      'cameraHealth.recording.seconds {"count":0}',
    );
    expect(screen.getByTestId("recording-gaps")).toHaveTextContent("0");
    expect(screen.getByTestId("recording-analyzed")).toHaveTextContent(
      'time.second_one {"ns":"common","time":1}',
    );
  });

  it.each([Number.NaN, 0, -1])(
    "keeps invalid assessment timestamps unavailable (%s)",
    (timestamp) => {
      show(
        recording({ coverage_percent: 49.5, latest_analyzed_end: timestamp }),
      );
      expect(
        screen.getByTestId("camera-health-recording-details"),
      ).toHaveTextContent('cameraHealth.percent {"value":"49.5"}');
      expect(screen.getByTestId("recording-checkedThrough")).toHaveTextContent(
        "cameraHealth.recording.status.unknown",
      );
    },
  );
});
