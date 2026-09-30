import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CameraSourceState from "./CameraSourceState";
import type {
  Go2rtcStateResponse,
  Go2rtcStreamState,
} from "@/types/fork/go2rtcState";

const fixture = vi.hoisted(() => ({
  useGo2rtcState: vi.fn(),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("@/hooks/fork/use-go2rtc-state", () => ({
  useGo2rtcState: fixture.useGo2rtcState,
}));

const stream = (
  overrides: Partial<Go2rtcStreamState> = {},
): Go2rtcStreamState => ({
  name: "front_door",
  configured: true,
  connected: true,
  bytes_received: 4096,
  bytes_per_second: 64_000,
  producers: 1,
  consumers: 2,
  codecs: ["H264", "AAC"],
  source: "rtsp://10.0.0.5:554",
  ...overrides,
});

function show(
  data: Go2rtcStateResponse | undefined,
  error: unknown = undefined,
) {
  fixture.useGo2rtcState.mockReturnValue({ data, error, isLoading: false });
  return render(<CameraSourceState camera="front_door" />);
}

const state = (streams: Go2rtcStreamState[]): Go2rtcStateResponse => ({
  available: true,
  updated: 1,
  cameras: { front_door: { streams } },
});

describe("CameraSourceState", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps polling on while it is mounted", () => {
    show(state([stream()]));
    expect(fixture.useGo2rtcState).toHaveBeenCalledWith(true);
    expect(screen.getByTestId("source-state")).toHaveAccessibleName(
      "cameraHealth.source.title",
    );
  });

  it("shows a connected stream with its source, rate, readers and codecs", () => {
    show(state([stream()]));
    const row = screen.getByTestId("source-state-stream");
    expect(row).toHaveAttribute("data-state", "connected");
    expect(row).toHaveTextContent("front_door");
    expect(row).toHaveTextContent("cameraHealth.source.state.connected");
    expect(row).toHaveTextContent("rtsp://10.0.0.5:554");
    expect(row).toHaveTextContent(
      'cameraHealth.source.rate.kbit {"value":"512"}',
    );
    expect(row).toHaveTextContent('cameraHealth.source.consumers {"count":2}');
    expect(row).toHaveTextContent("H264, AAC");
    // The state is said in words and marked by an icon, not by color alone.
    expect(row.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByTestId("source-state-hint")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("source-state-message"),
    ).not.toBeInTheDocument();
  });

  it("says the rate is still being measured on the first sample", () => {
    show(state([stream({ bytes_per_second: null })]));
    expect(screen.getByTestId("source-state-stream")).toHaveTextContent(
      "cameraHealth.source.measuring",
    );
  });

  it("shows a stream that is not connected without a rate, and explains idle streams", () => {
    show(
      state([
        stream(),
        stream({
          name: "front_door_sub",
          connected: false,
          bytes_received: 0,
          bytes_per_second: 0,
          consumers: 0,
          codecs: [],
        }),
      ]),
    );
    const rows = screen.getAllByTestId("source-state-stream");
    expect(rows).toHaveLength(2);
    const idle = rows[1] as HTMLElement;
    expect(idle).toHaveAttribute("data-state", "notConnected");
    expect(idle).toHaveTextContent("cameraHealth.source.state.notConnected");
    expect(idle).toHaveTextContent('cameraHealth.source.consumers {"count":0}');
    expect(idle).not.toHaveTextContent("cameraHealth.source.rate");
    expect(idle).not.toHaveTextContent("cameraHealth.source.measuring");
    expect(screen.getByTestId("source-state-hint")).toHaveTextContent(
      "cameraHealth.source.idleHint",
    );
  });

  it("shows a stream go2rtc does not have with only its name and state", () => {
    show(
      state([
        stream({
          configured: false,
          connected: false,
          bytes_per_second: null,
          consumers: 0,
          codecs: [],
          source: null,
        }),
      ]),
    );
    const row = screen.getByTestId("source-state-stream");
    expect(row).toHaveAttribute("data-state", "notConfigured");
    expect(row).toHaveTextContent("cameraHealth.source.state.notConfigured");
    expect(within(row).queryByText(/consumers/)).not.toBeInTheDocument();
    expect(row.querySelector("p")).not.toBeInTheDocument();
    expect(screen.queryByTestId("source-state-hint")).not.toBeInTheDocument();
  });

  it("shows one muted line when go2rtc is unavailable", () => {
    show({ available: false, updated: 1, cameras: {} });
    expect(screen.getByTestId("source-state-message")).toHaveTextContent(
      "cameraHealth.source.unavailable",
    );
    expect(screen.queryByTestId("source-state-stream")).not.toBeInTheDocument();
  });

  it("treats a failed request like an unavailable go2rtc", () => {
    show(undefined, new Error("500"));
    expect(screen.getByTestId("source-state-message")).toHaveTextContent(
      "cameraHealth.source.unavailable",
    );
  });

  it("keeps showing the last state when a refresh fails", () => {
    show(state([stream()]), new Error("timeout"));
    expect(screen.getByTestId("source-state-stream")).toBeInTheDocument();
  });

  it("says it is checking before the first response", () => {
    show(undefined);
    expect(screen.getByTestId("source-state-message")).toHaveTextContent(
      "cameraHealth.source.loading",
    );
  });

  it("says so when the camera has no go2rtc stream", () => {
    show({ available: true, updated: 1, cameras: {} });
    expect(screen.getByTestId("source-state-message")).toHaveTextContent(
      "cameraHealth.source.none",
    );
    fixture.useGo2rtcState.mockReturnValue({
      data: state([]),
      error: undefined,
      isLoading: false,
    });
    render(<CameraSourceState camera="front_door" />);
    expect(screen.getAllByTestId("source-state-message")).toHaveLength(2);
  });
});
