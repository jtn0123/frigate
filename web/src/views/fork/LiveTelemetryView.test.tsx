import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import fork from "../../../public/locales/en/fork.json";
import type {
  LiveTelemetry,
  ReadStatus,
} from "@/hooks/fork/use-live-telemetry";
import {
  buildCameraRows,
  telemetryTotals,
  type SparkSeries,
} from "@/lib/fork/live-telemetry";
import type { Go2rtcStateResponse } from "@/types/fork/go2rtcState";
import type { Go2rtcStreamsResponse } from "@/types/fork/go2rtcStreams";
import LiveTelemetryView from "./LiveTelemetryView";

const fixture = vi.hoisted(() => ({
  telemetry: undefined as unknown,
  phone: false,
  stored: undefined as boolean | undefined,
}));

vi.mock("@/hooks/fork/use-live-telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/fork/use-live-telemetry")>()),
  useLiveTelemetry: () => fixture.telemetry,
}));
vi.mock("@/hooks/fork/use-viewport", () => ({
  useIsMobile: () => fixture.phone,
}));
// what usePersistence hands back once IndexedDB answered: the stored choice,
// or the default when there is none
vi.mock("@/hooks/use-persistence", () => ({
  usePersistence: (_key: string, defaultValue: boolean) => [
    fixture.stored ?? defaultValue,
    vi.fn(),
    true,
    vi.fn(),
  ],
}));
vi.mock("@/hooks/use-camera-friendly-name", () => ({
  resolveCameraName: (_config: unknown, camera: string) => camera,
}));

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    ns: ["fork"],
    defaultNS: "fork",
    resources: { en: { fork } },
    interpolation: { escapeValue: false },
  });
});

const BROWSER = "Mozilla/5.0 (X11; Linux x86_64)";
const mse = (port: number) => ({
  format_name: "mse/fmp4",
  protocol: "ws",
  remote_addr: `127.0.0.1:${port} forwarded 192.168.1.40`,
  user_agent: BROWSER,
});
const frigateReader = {
  format_name: "rtsp",
  protocol: "rtsp+tcp",
  remote_addr: "127.0.0.1:43122",
  user_agent: "FFmpeg Frigate/0.17.0",
};

function stream(name: string) {
  return {
    name,
    configured: true,
    connected: true,
    bytes_received: 1_000_000,
    bytes_per_second: 250_000,
    producers: 1,
    consumers: 2,
    codecs: ["H264"],
    source: "rtsp://10.0.0.5:554",
  };
}

const series = (values: number[]): SparkSeries => ({
  values,
  times: values.map((_, index) => index * 5),
});

/**
 * One browser on the Live dashboard playing street and walkway over MSE,
 * with Frigate's detect reader on street.
 */
function telemetry(overrides: Partial<LiveTelemetry> = {}): LiveTelemetry {
  const cameras = ["street", "walkway"].map((name) => ({
    name,
    inputs: [`rtsp://127.0.0.1:8554/${name}`],
  }));
  const state: Go2rtcStateResponse = {
    available: true,
    updated: 100,
    cameras: {
      street: { streams: [stream("street")] },
      walkway: { streams: [stream("walkway")] },
    },
  };
  const streams: Go2rtcStreamsResponse = {
    street: { consumers: [frigateReader, mse(52010)] },
    walkway: { consumers: [mse(52011)] },
  };
  const rows = buildCameraRows(cameras, state, streams);
  return {
    config: undefined,
    rows,
    totals: telemetryTotals(rows, state, streams),
    detectors: [
      {
        name: "coral",
        latest: 8.6,
        level: "ok",
        series: series([8.4, 8.6]),
      },
      {
        name: "cpu",
        latest: 64.2,
        level: "warning",
        series: series([60, 64.2]),
      },
    ],
    go2rtcStatus: "ready",
    viewersStatus: "ready",
    latencyStatus: "ready",
    totalSeries: series([500_000, 510_000]),
    viewerSeries: series([1, 1]),
    cameraSeries: () => series([250_000, 255_000]),
    ...overrides,
  };
}

function renderView() {
  return render(
    <I18nextProvider i18n={i18n}>
      <LiveTelemetryView isActive />
    </I18nextProvider>,
  );
}

beforeEach(() => {
  fixture.telemetry = telemetry();
  fixture.phone = false;
  fixture.stored = undefined;
});

describe("LiveTelemetryView viewers", () => {
  it("shows one browser on two cameras as one viewer with two streams", () => {
    renderView();
    const card = screen.getByTestId("live-viewers");
    expect(within(card).getByTestId("live-value")).toHaveTextContent(/^1$/);
    expect(
      within(card).getByTestId("live-viewers-breakdown"),
    ).toHaveTextContent("2 streams: 2 MSE");
    expect(within(card).getByTestId("live-viewers-internal")).toHaveTextContent(
      "Not counted: 1 Frigate reader",
    );
  });

  it("counts streams per camera, under a Streams heading", () => {
    renderView();
    expect(
      screen.getByRole("columnheader", { name: "Streams" }),
    ).toBeInTheDocument();
    for (const camera of ["street", "walkway"]) {
      expect(
        within(screen.getByTestId(`live-camera-${camera}`)).getByTestId(
          "live-camera-streams",
        ),
      ).toHaveTextContent(/^1$/);
    }
  });
});

describe("LiveTelemetryView stream names", () => {
  it("does not repeat the camera name when it reads its namesake stream", () => {
    renderView();
    for (const camera of ["street", "walkway"]) {
      expect(
        within(screen.getByTestId(`live-camera-${camera}`)).queryByTestId(
          "live-camera-stream-names",
        ),
      ).not.toBeInTheDocument();
    }
  });

  it("names the streams when they differ from the camera", () => {
    const base = telemetry();
    fixture.telemetry = {
      ...base,
      rows: base.rows.map((row) =>
        row.camera === "street"
          ? { ...row, streams: ["street", "street_sub"] }
          : { ...row, streams: ["walkway_main"] },
      ),
    };
    renderView();
    expect(
      within(screen.getByTestId("live-camera-street")).getByTestId(
        "live-camera-stream-names",
      ),
    ).toHaveTextContent("street · street_sub");
    expect(
      within(screen.getByTestId("live-camera-walkway")).getByTestId(
        "live-camera-stream-names",
      ),
    ).toHaveTextContent("walkway_main");
  });
});

describe("LiveTelemetryView viewers popover", () => {
  it("explains the count in three short paragraphs", async () => {
    renderView();
    fireEvent.click(
      screen.getByRole("button", { name: "How viewers are counted" }),
    );
    const info = await screen.findByTestId("live-viewers-info");
    const paragraphs = within(info).getAllByText(/./, { selector: "p" });
    expect(paragraphs.map((p) => p.textContent)).toEqual([
      "How viewers are counted",
      fork.liveTelemetry.viewers.explanation,
      fork.liveTelemetry.viewers.explanationNotCounted,
      fork.liveTelemetry.viewers.explanationLimits,
    ]);
  });
});

describe("LiveTelemetryView Live dot", () => {
  const cases: [ReadStatus, string, string][] = [
    ["ready", "Live: the figures are updating", "bg-success"],
    ["loading", "Loading the live figures", "bg-muted-foreground"],
    ["unavailable", "Paused: go2rtc is not reachable", "bg-orange-400"],
  ];

  it.each(cases)("follows the go2rtc read when %s", (status, label, color) => {
    fixture.telemetry = telemetry({ go2rtcStatus: status });
    renderView();

    const dot = screen.getByRole("img", { name: label });
    expect(dot).toHaveAttribute("data-state", status);
    expect(dot.lastElementChild).toHaveClass(color);
    const ping = within(dot).queryByTestId("live-dot-ping");
    if (status === "ready") {
      // the ping stops for people who asked for reduced motion
      expect(ping).toHaveClass("motion-safe:animate-ping");
      expect(ping?.className).not.toMatch(/(?:^|\s)animate-ping/);
    } else {
      expect(ping).toBeNull();
    }
  });
});

describe("LiveTelemetryView sparklines", () => {
  it("draws no blank band before a card has two samples", () => {
    fixture.telemetry = telemetry({
      totalSeries: series([500_000]),
      viewerSeries: series([]),
    });
    renderView();
    expect(
      within(screen.getByTestId("live-bitrate")).queryByTestId("sparkline"),
    ).toBeNull();
    expect(
      within(screen.getByTestId("live-viewers")).queryByTestId("sparkline"),
    ).toBeNull();
  });

  it("draws the card sparklines once they have a line", () => {
    renderView();
    expect(
      within(screen.getByTestId("live-bitrate")).getByTestId("sparkline"),
    ).toHaveAttribute("data-points", "2");
    expect(
      within(screen.getByTestId("live-viewers")).getByTestId("sparkline"),
    ).toHaveAttribute("data-points", "2");
  });
});

describe("LiveTelemetryView layout", () => {
  it("opens the camera table on a desktop", () => {
    renderView();
    expect(screen.queryByTestId("live-compact")).toBeNull();
    expect(screen.getByTestId("live-camera-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("live-camera-table")).toBeInTheDocument();
  });

  it("keeps a desktop table the user closed closed", () => {
    fixture.stored = false;
    renderView();
    expect(screen.getByTestId("live-camera-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByTestId("live-camera-table")).toBeNull();
  });

  it("shows one compact row without sparklines on a phone", () => {
    fixture.phone = true;
    renderView();

    const compact = screen.getByTestId("live-compact");
    expect(
      within(within(compact).getByTestId("live-bitrate")).getByTestId(
        "live-value",
      ),
    ).toHaveTextContent("4.0 Mbit/s");
    expect(
      within(within(compact).getByTestId("live-viewers")).getByTestId(
        "live-value",
      ),
    ).toHaveTextContent(/^1$/);
    // the slowest detector, tinted like the card
    const latency = within(compact).getByTestId("live-latency");
    expect(latency).toHaveAttribute("data-level", "warning");
    expect(within(latency).getByTestId("live-value")).toHaveTextContent(
      "64.2 ms",
    );
    expect(within(compact).getByTestId("live-compact-note")).toHaveTextContent(
      "2 of 2 cameras measured through go2rtc",
    );
    expect(screen.queryAllByTestId("sparkline")).toHaveLength(0);
    expect(screen.queryByTestId("live-viewers-breakdown")).toBeNull();
  });

  it("starts the camera table closed on a phone", () => {
    fixture.phone = true;
    renderView();
    expect(screen.getByTestId("live-camera-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByTestId("live-camera-table")).toBeNull();
  });

  it("opens the phone table when the user chose to", () => {
    fixture.phone = true;
    fixture.stored = true;
    renderView();
    expect(screen.getByTestId("live-camera-table")).toBeInTheDocument();
  });

  it("says go2rtc is unreachable under the phone row", () => {
    fixture.phone = true;
    fixture.telemetry = telemetry({ go2rtcStatus: "unavailable" });
    renderView();
    const compact = screen.getByTestId("live-compact");
    expect(
      within(within(compact).getByTestId("live-bitrate")).getByTestId(
        "live-value",
      ),
    ).toHaveTextContent(/^-$/);
    expect(
      within(within(compact).getByTestId("live-viewers")).getByTestId(
        "live-value",
      ),
    ).toHaveTextContent(/^-$/);
    expect(within(compact).getByTestId("live-compact-note")).toHaveTextContent(
      "go2rtc is not reachable",
    );
  });
});
