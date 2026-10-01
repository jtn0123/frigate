import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LogSummaryGroup,
  LogSummaryResponse,
} from "@/types/fork/logSummary";
import type { LogType } from "@/types/log";
import LogSummaryPanel from "./LogSummaryPanel";

const mocks = vi.hoisted(() => ({
  useLogSummary: vi.fn(),
  isForkEnabled: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/hooks/fork/use-log-summary", () => ({
  useLogSummary: mocks.useLogSummary,
}));
vi.mock("@/fork/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/fork/flags")>()),
  isForkEnabled: mocks.isForkEnabled,
}));
vi.mock("@/api/fork/client", () => ({
  useApi: () => ({
    data: {
      ui: { timezone: "UTC", time_format: "24hour" },
      cameras: { doorbell: { name: "doorbell", friendly_name: "Front Bell" } },
    },
  }),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) => {
      if (key.startsWith("time.")) return "MMM d, HH:mm";
      const { ns: _ns, ...values } = options ?? {};
      return Object.keys(values).length === 0
        ? key
        : `${key} ${JSON.stringify(values)}`;
    },
  }),
}));

const START = 1_790_000_000;

function group(overrides: Partial<LogSummaryGroup> = {}): LogSummaryGroup {
  return {
    camera: "doorbell",
    service: "frigate",
    hour: START,
    level: "info",
    count: 31_000,
    first: START + 60,
    last: START + 3_000,
    message: "No frames received from doorbell in 20 seconds",
    signature: "No frames received from doorbell in # seconds",
    ...overrides,
  };
}

function response(
  overrides: Partial<LogSummaryResponse> = {},
): LogSummaryResponse {
  return {
    hours: 24,
    start: START,
    end: START + 86_400,
    covered_from: START,
    sources: {
      frigate: {
        available: true,
        partial: false,
        lines: 100,
        covered_from: START,
        covered_to: START + 86_400,
      },
    },
    total: 31_742,
    unattributed: 3,
    cameras: { doorbell: 31_734, garage_cam: 5 },
    truncated: false,
    groups: [
      group(),
      group({ hour: START + 3_600, count: 734, last: START + 7_000 }),
      group({
        camera: "garage_cam",
        level: "error",
        count: 5,
        message: "Error opening input file rtsp://127.0.0.1:8554/garage_cam.",
        signature: "Error opening input file",
      }),
      group({
        camera: null,
        level: "warning",
        count: 3,
        message: "Something nameless failed",
        signature: "Something nameless failed",
      }),
      group({ service: "go2rtc", count: 9, message: "[rtsp] timed out" }),
    ],
    ...overrides,
  };
}

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function renderPanel(
  service: LogType = "frigate",
  camera = "",
  entry = "/logs",
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <LogSummaryPanel service={service} camera={camera} />
      <Location />
    </MemoryRouter>,
  );
}

function rowAt(index: number): HTMLElement {
  const row = screen.getAllByTestId("log-summary-row")[index];
  if (!row) throw new Error(`no summary row ${index}`);
  return row;
}

function loaded(data: LogSummaryResponse = response()) {
  mocks.useLogSummary.mockReturnValue({
    data,
    error: undefined,
    isLoading: false,
    refresh: mocks.refresh,
  });
}

describe("LogSummaryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isForkEnabled.mockReturnValue(true);
    loaded();
  });

  it("is collapsed with a one-line summary naming the top camera", () => {
    renderPanel();
    const panel = screen.getByTestId("log-summary");
    expect(mocks.useLogSummary).toHaveBeenCalledWith(true, "");
    expect(screen.getByTestId("log-summary-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByTestId("log-summary-line")).toHaveTextContent(
      'logSummary.summaryTop {"count":31742,"total":"31,742","hours":24,"camera":"Front Bell","top":"31,734"}',
    );
    expect(within(panel).queryByRole("table")).toBeNull();
  });

  it("expands to a table of merged rows sorted by count", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("log-summary-toggle"));
    expect(screen.getByTestId("log-summary-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual([
      "logSummary.column.camera",
      "logSummary.column.message",
      "logSummary.column.count",
      "logSummary.column.first",
      "logSummary.column.last",
    ]);
    expect(screen.getAllByTestId("log-summary-row")).toHaveLength(3);
    expect(rowAt(0)).toHaveTextContent("Front Bell");
    expect(rowAt(0)).toHaveTextContent("31,734");
    expect(rowAt(0)).toHaveTextContent("logSummary.level.info");
    expect(rowAt(1)).toHaveTextContent("garage cam");
    expect(rowAt(1)).toHaveTextContent("logSummary.level.error");
    expect(rowAt(2)).toHaveTextContent("logSummary.noCamera");
    expect(rowAt(2)).toHaveTextContent("logSummary.level.warning");
    expect(rowAt(0).querySelectorAll("td").item(2).textContent).toMatch(
      /^[A-Z][a-z]{2} \d+, \d{2}:\d{2}$/,
    );
    expect(screen.queryByText(/logSummary\.(coverage|truncated)/)).toBeNull();
    fireEvent.click(screen.getByTestId("log-summary-toggle"));
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("filters the frigate log to a row's camera through a real button", () => {
    renderPanel("frigate", "", "/logs?other=1");
    fireEvent.click(screen.getByTestId("log-summary-toggle"));
    expect(within(rowAt(2)).queryByRole("button")).toBeNull();
    fireEvent.click(
      within(rowAt(0)).getByRole("button", {
        name: 'logSummary.filterTo {"camera":"Front Bell"}',
      }),
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      "?other=1&camera=doorbell",
    );
  });

  it("asks for the filtered camera and does not offer it again", () => {
    loaded(response({ groups: [group()] }));
    renderPanel("frigate", "doorbell");
    expect(mocks.useLogSummary).toHaveBeenCalledWith(true, "doorbell");
    fireEvent.click(screen.getByTestId("log-summary-toggle"));
    expect(
      within(screen.getByTestId("log-summary-row")).queryByRole("button"),
    ).toBeNull();
  });

  it("shows the go2rtc groups without camera buttons", () => {
    loaded(
      response({
        groups: [group({ service: "go2rtc", count: 9 }), group()],
        sources: {},
      }),
    );
    renderPanel("go2rtc");
    expect(screen.getByTestId("log-summary-line")).toHaveTextContent(
      '"total":"9"',
    );
    fireEvent.click(screen.getByTestId("log-summary-toggle"));
    const row = screen.getByTestId("log-summary-row");
    expect(row).toHaveTextContent("Front Bell");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("summarizes without a top camera when no row names one", () => {
    loaded(response({ groups: [group({ camera: null, count: 1 })] }));
    renderPanel();
    expect(screen.getByTestId("log-summary-line")).toHaveTextContent(
      'logSummary.summary {"count":1,"total":"1","hours":24}',
    );
  });

  it("notes a log that does not reach back and a cut-off list", () => {
    const data = response({ truncated: true });
    data.sources.frigate!.covered_from = START + 7_200;
    loaded(data);
    renderPanel();
    fireEvent.click(screen.getByTestId("log-summary-toggle"));
    const panel = screen.getByTestId("log-summary");
    expect(panel).toHaveTextContent(/logSummary\.coverage \{"time":"[^"]+"\}/);
    expect(panel).toHaveTextContent("logSummary.truncated");
  });

  it("notes coverage alone when nothing was cut off", () => {
    const data = response();
    data.sources.frigate!.covered_from = START + 7_200;
    loaded(data);
    renderPanel();
    fireEvent.click(screen.getByTestId("log-summary-toggle"));
    const panel = screen.getByTestId("log-summary");
    expect(panel).toHaveTextContent("logSummary.coverage");
    expect(panel).not.toHaveTextContent("logSummary.truncated");
  });

  it("caps the rows it renders", () => {
    loaded(
      response({
        groups: Array.from({ length: 60 }, (_, index) =>
          group({ signature: `message ${index}`, count: 100 - index }),
        ),
      }),
    );
    renderPanel();
    fireEvent.click(screen.getByTestId("log-summary-toggle"));
    expect(screen.getAllByTestId("log-summary-row")).toHaveLength(50);
    expect(screen.getByTestId("log-summary")).toHaveTextContent(
      "logSummary.truncated",
    );
  });

  it("says so when nothing repeated and cannot be expanded", () => {
    loaded(response({ groups: [] }));
    renderPanel();
    expect(screen.getByTestId("log-summary-line")).toHaveTextContent(
      'logSummary.none {"hours":24}',
    );
    expect(screen.getByTestId("log-summary-toggle")).toBeDisabled();
  });

  it("shows loading, then an error with a retry", () => {
    mocks.useLogSummary.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      refresh: mocks.refresh,
    });
    const { unmount } = renderPanel();
    expect(screen.getByTestId("log-summary-line")).toHaveTextContent(
      "logSummary.loading",
    );
    expect(screen.queryByText("errorState.retry")).toBeNull();
    unmount();

    mocks.useLogSummary.mockReturnValue({
      data: undefined,
      error: new Error("boom"),
      isLoading: false,
      refresh: mocks.refresh,
    });
    renderPanel();
    expect(screen.getByTestId("log-summary-line")).toHaveTextContent(
      "logSummary.error",
    );
    fireEvent.click(screen.getByText("errorState.retry"));
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("renders nothing for other logs or with the flag off", () => {
    const { unmount } = renderPanel("nginx");
    expect(screen.queryByTestId("log-summary")).toBeNull();
    expect(mocks.useLogSummary).toHaveBeenLastCalledWith(false, "");
    unmount();

    mocks.isForkEnabled.mockReturnValue(false);
    renderPanel("frigate");
    expect(screen.queryByTestId("log-summary")).toBeNull();
    expect(mocks.isForkEnabled).toHaveBeenCalledWith("cameraHealth");
    expect(mocks.useLogSummary).toHaveBeenLastCalledWith(false, "");
  });
});
