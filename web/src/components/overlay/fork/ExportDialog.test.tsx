import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createContext, useContext, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ExportMode } from "@/types/filter";
import type { TimeRange } from "@/types/timeline";
import ExportDialog, {
  ExportContent,
  ExportPreviewDialog,
} from "../ExportDialog";

type ContentProps = Parameters<typeof ExportContent>[0];
type DialogProps = Parameters<typeof ExportDialog>[0];

const fixture = vi.hoisted(() => ({
  config: undefined as unknown,
  cases: undefined as unknown,
  events: undefined as unknown,
  eventsLoading: false,
  admin: true,
  desktop: true,
  swrKeys: [] as unknown[],
}));

const axiosPost = vi.fn<(url: string, body?: unknown) => Promise<unknown>>();
const toastSuccess = vi.fn<(message: string, options?: unknown) => void>();
const toastError = vi.fn<(message: string, options?: unknown) => void>();

vi.mock("swr", () => ({
  default: (key: unknown) => {
    fixture.swrKeys.push(key);
    if (Array.isArray(key)) {
      return { data: fixture.events, isLoading: fixture.eventsLoading };
    }
    if (key === "config") {
      return { data: fixture.config, isLoading: false };
    }
    if (key === "cases") {
      return { data: fixture.cases, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  },
}));
vi.mock("axios", () => ({
  default: {
    post: (url: string, body?: unknown) => axiosPost(url, body),
  },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (message: string, options?: unknown) =>
      toastSuccess(message, options),
    error: (message: string, options?: unknown) => toastError(message, options),
  },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) => {
      const { ns: _ns, ...rest } = options ?? {};
      return Object.keys(rest).length > 0
        ? `${key} ${JSON.stringify(rest)}`
        : key;
    },
  }),
}));
vi.mock("@/hooks/use-is-admin", () => ({
  useIsAdmin: () => fixture.admin,
}));
vi.mock("react-device-detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-device-detect")>()),
  get isDesktop() {
    return fixture.desktop;
  },
  get isMobile() {
    return !fixture.desktop;
  },
}));
vi.mock("@/components/overlay/SaveExportOverlay", () => ({
  default: (props: {
    show: boolean;
    hidePreview?: boolean;
    saveLabel?: string;
    isSaving?: boolean;
    onPreview: () => void;
    onSave: () => void;
    onCancel: () => void;
  }) =>
    props.show ? (
      <div data-testid="save-overlay">
        <span data-testid="save-overlay-label">
          {props.saveLabel ?? "default-save"}
        </span>
        <span data-testid="save-overlay-hide-preview">
          {String(Boolean(props.hidePreview))}
        </span>
        <button type="button" onClick={props.onPreview}>
          overlay-preview
        </button>
        <button type="button" onClick={props.onSave}>
          overlay-save
        </button>
        <button type="button" onClick={props.onCancel}>
          overlay-cancel
        </button>
      </div>
    ) : null,
}));
vi.mock("@/components/player/GenericVideoPlayer", () => ({
  GenericVideoPlayer: ({ source }: { source: string }) => (
    <div data-testid="video-player">{source}</div>
  ),
}));
vi.mock("@/components/overlay/CustomTimeSelector", () => ({
  CustomTimeSelector: ({
    setRange,
    startLabel,
  }: {
    setRange: (range: { after: number; before: number }) => void;
    startLabel: string;
  }) => (
    <button
      type="button"
      data-testid="custom-time"
      onClick={() => setRange({ after: 10, before: 20 })}
    >
      {startLabel}
    </button>
  ),
}));

// Radix Select relies on pointer APIs jsdom lacks; a context backed stand-in
// keeps the value plumbing testable.
type SelectCtx = {
  value?: string | undefined;
  onValueChange?: ((value: string) => void) | undefined;
};
const SelectContext = createContext<SelectCtx>({});
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: SelectCtx & { children?: ReactNode }) => (
    <SelectContext.Provider value={{ value, onValueChange }}>
      <div data-testid="select" data-value={value}>
        {children}
      </div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectSeparator: () => <hr />,
  SelectItem: function SelectItem({
    value,
    children,
  }: {
    value: string;
    children?: ReactNode;
  }) {
    const ctx = useContext(SelectContext);
    return (
      <button
        type="button"
        role="option"
        aria-selected={ctx.value === value}
        onClick={() => ctx.onValueChange?.(value)}
      >
        {children}
      </button>
    );
  },
}));

// Mid-June, far from any DST switch, so hour arithmetic is exact.
const LATEST = Date.UTC(2026, 5, 15, 12, 0, 0) / 1000;
const EARLIEST = LATEST - 7 * 24 * 3600;
const CURRENT = LATEST - 6 * 3600;

function baseConfig() {
  return {
    cameras: {
      front_door: {
        friendly_name: "Front Door",
        record: { sub: { enabled: true } },
      },
      back_yard: { record: { sub: { enabled: false } } },
      _replay_old: { record: { sub: { enabled: true } } },
    },
    camera_groups: {
      outside: { icon: "LuCar", order: 2, cameras: ["back_yard", "missing"] },
      porch: { icon: "not-an-icon", order: 1, cameras: ["front_door"] },
      empty: { icon: "LuCar", order: 0, cameras: ["gone"] },
    },
  };
}

// Overrides may pass `range: undefined` to render without a range.
type WithRange<T> = Partial<Omit<T, "range">> & {
  range?: TimeRange | undefined;
};
const DEFAULT_RANGE: TimeRange = { after: LATEST - 3600, before: LATEST };

function applyRange<T extends { range?: TimeRange }>(
  props: Omit<T, "range">,
  overrides: { range?: TimeRange | undefined },
): Omit<T, "range"> & { range?: TimeRange } {
  const range = "range" in overrides ? overrides.range : DEFAULT_RANGE;
  return range ? { ...props, range } : props;
}

function contentProps(overrides: WithRange<ContentProps> = {}): ContentProps {
  const { range: _range, ...rest } = overrides;
  const props: Omit<ContentProps, "range"> = {
    camera: "front_door",
    latestTime: LATEST,
    earliestTime: EARLIEST,
    currentTime: CURRENT,
    name: "",
    singleNewCaseName: "",
    singleNewCaseDescription: "",
    batchCaseSelection: "none",
    newCaseName: "",
    newCaseDescription: "",
    activeTab: "export",
    stream: "auto",
    isStartingExport: false,
    onStartExport: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
    setActiveTab: vi.fn(),
    setStream: vi.fn(),
    setName: vi.fn(),
    setSelectedCaseId: vi.fn(),
    setSingleNewCaseName: vi.fn(),
    setSingleNewCaseDescription: vi.fn(),
    setBatchCaseSelection: vi.fn(),
    setNewCaseName: vi.fn(),
    setNewCaseDescription: vi.fn(),
    setRange: vi.fn(),
    setMode: vi.fn(),
    onSelectFromTimeline: vi.fn(),
    onCancel: vi.fn(),
    ...rest,
  };
  return applyRange<ContentProps>(props, overrides);
}

// DialogTitle needs the Dialog root context; the root itself renders nothing.
function ContentHarness(props: ContentProps) {
  return (
    <Dialog>
      <TooltipProvider>
        <ExportContent {...props} />
      </TooltipProvider>
    </Dialog>
  );
}

function renderContent(props: ContentProps) {
  return render(<ContentHarness {...props} />);
}

function dialogProps(overrides: WithRange<DialogProps> = {}): DialogProps {
  const { range: _range, ...rest } = overrides;
  const props: Omit<DialogProps, "range"> = {
    camera: "front_door",
    latestTime: LATEST,
    earliestTime: EARLIEST,
    currentTime: CURRENT,
    mode: "select",
    showPreview: false,
    setRange: vi.fn(),
    setMode: vi.fn(),
    setShowPreview: vi.fn(),
    ...rest,
  };
  return applyRange<DialogProps>(props, overrides);
}

function renderDialog(props: DialogProps) {
  const view = render(
    <TooltipProvider>
      <ExportDialog {...props} />
    </TooltipProvider>,
  );
  return {
    ...view,
    rerenderWith: (next: DialogProps) =>
      view.rerender(
        <TooltipProvider>
          <ExportDialog {...next} />
        </TooltipProvider>,
      ),
  };
}

function hourRadio(count: number) {
  return screen.getByRole("radio", {
    name: `export.time.lastHour {"count":${count}}`,
  });
}

function cameraCard(name: string) {
  return screen.getByText(name).closest("button");
}

beforeEach(() => {
  fixture.config = baseConfig();
  fixture.cases = [
    { id: "c2", name: "Zulu case" },
    { id: "c1", name: "Alpha case" },
  ];
  fixture.events = [];
  fixture.eventsLoading = false;
  fixture.admin = true;
  fixture.desktop = true;
  fixture.swrKeys = [];
  axiosPost.mockResolvedValue({ data: {} });
  Element.prototype.scrollIntoView = vi.fn();
});

describe("ExportContent export tab", () => {
  it("lists every preset and recomputes the range when one is picked", () => {
    const props = contentProps();
    renderContent(props);

    expect(screen.getByText("menu.export")).toBeInTheDocument();
    for (const count of [1, 4, 8, 12, 24]) {
      expect(hourRadio(count)).toBeInTheDocument();
    }
    expect(screen.getByText("export.time.fromTimeline")).toBeInTheDocument();
    expect(screen.getByText("export.time.custom")).toBeInTheDocument();

    for (const count of [4, 8, 12, 24]) {
      fireEvent.click(hourRadio(count));
      expect(props.setRange).toHaveBeenLastCalledWith({
        before: LATEST,
        after: LATEST - count * 3600,
      });
    }
    fireEvent.click(hourRadio(1));
    expect(props.setRange).toHaveBeenLastCalledWith({
      before: LATEST,
      after: LATEST - 3600,
    });
  });

  it("shows the custom selector for the custom option", () => {
    const props = contentProps();
    renderContent(props);

    expect(screen.queryByTestId("custom-time")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "export.time.custom" }));
    expect(props.setRange).toHaveBeenLastCalledWith({
      before: LATEST,
      after: LATEST - 3600,
    });
    fireEvent.click(screen.getByTestId("custom-time"));
    expect(props.setRange).toHaveBeenLastCalledWith({ after: 10, before: 20 });
  });

  it("enters timeline mode with a minute around the playhead", () => {
    const props = contentProps();
    renderContent(props);

    fireEvent.click(
      screen.getByRole("radio", { name: "export.time.fromTimeline" }),
    );
    const action = screen.getByRole("button", {
      name: "export.selectOrExport",
    });
    expect(action).toHaveTextContent("export.select");
    fireEvent.click(action);

    expect(props.setRange).toHaveBeenLastCalledWith({
      after: CURRENT - 30,
      before: CURRENT + 30,
    });
    expect(props.setMode).toHaveBeenCalledWith("timeline");
    expect(props.onStartExport).not.toHaveBeenCalled();
  });

  it("starts the export and resets the preset when queued", async () => {
    const props = contentProps();
    renderContent(props);

    fireEvent.click(hourRadio(4));
    expect(hourRadio(4)).toHaveAttribute("aria-checked", "true");
    const action = screen.getByRole("button", {
      name: "export.selectOrExport",
    });
    expect(action).toHaveTextContent("export.export");
    fireEvent.click(action);

    await waitFor(() =>
      expect(hourRadio(1)).toHaveAttribute("aria-checked", "true"),
    );
    expect(props.onStartExport).toHaveBeenCalledTimes(1);
  });

  it("keeps the preset when the export is not queued", async () => {
    const onStartExport = vi.fn<() => Promise<boolean>>(() =>
      Promise.resolve(false),
    );
    const props = contentProps({ onStartExport });
    renderContent(props);

    fireEvent.click(hourRadio(8));
    fireEvent.click(
      screen.getByRole("button", { name: "export.selectOrExport" }),
    );
    await waitFor(() => expect(onStartExport).toHaveBeenCalled());
    expect(hourRadio(8)).toHaveAttribute("aria-checked", "true");
  });

  it("shows the queueing label and disables export while starting", () => {
    renderContent(contentProps({ isStartingExport: true }));
    const action = screen.getByRole("button", {
      name: "export.selectOrExport",
    });
    expect(action).toBeDisabled();
    expect(action).toHaveTextContent("export.queueing");
  });

  it("forwards the export name and cancel", () => {
    const props = contentProps({ name: "Clip" });
    renderContent(props);

    const input = screen.getByPlaceholderText("export.name.placeholder");
    expect(input).toHaveValue("Clip");
    fireEvent.change(input, { target: { value: "Package" } });
    expect(props.setName).toHaveBeenCalledWith("Package");

    fireEvent.click(screen.getByRole("button", { name: "button.cancel" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("offers every stream when the camera records a sub stream", () => {
    const props = contentProps();
    renderContent(props);

    expect(screen.getByText("export.stream.label")).toBeInTheDocument();
    expect(screen.getByText("export.stream.autoDesc")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "export.stream.sub" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "export.stream.main" }));
    expect(props.setStream).toHaveBeenCalledWith("main");
  });

  it("hides the stream choice and resets a stale pin without a sub stream", () => {
    const props = contentProps({ camera: "back_yard", stream: "sub" });
    renderContent(props);

    expect(screen.queryByText("export.stream.label")).not.toBeInTheDocument();
    expect(props.setStream).toHaveBeenCalledWith("auto");
  });

  it("hides the stream choice before the config loads", () => {
    fixture.config = undefined;
    renderContent(contentProps());
    expect(screen.queryByText("export.stream.label")).not.toBeInTheDocument();
  });

  it("lets admins pick a sorted case or none", () => {
    const props = contentProps({ selectedCaseId: "c1" });
    renderContent(props);

    expect(fixture.swrKeys).toContain("cases");
    const caseSelect = screen
      .getAllByTestId("select")
      .find((el) => el.getAttribute("data-value") === "c1");
    expect(caseSelect).toBeDefined();
    const names = within(caseSelect ?? document.body)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(names).toEqual([
      "label.none",
      "Alpha case",
      "Zulu case",
      "export.case.newCaseOption",
    ]);

    fireEvent.click(screen.getByRole("option", { name: "Zulu case" }));
    expect(props.setSelectedCaseId).toHaveBeenLastCalledWith("c2");
    fireEvent.click(screen.getByRole("option", { name: "label.none" }));
    expect(props.setSelectedCaseId).toHaveBeenLastCalledWith(undefined);
  });

  it("collects a new case name and description", () => {
    const props = contentProps({
      selectedCaseId: "new",
      singleNewCaseName: "Theft",
      singleNewCaseDescription: "Bike",
    });
    renderContent(props);

    const nameInput = screen.getByPlaceholderText(
      "export.case.newCaseNamePlaceholder",
    );
    expect(nameInput).toHaveValue("Theft");
    fireEvent.change(nameInput, { target: { value: "Theft 2" } });
    expect(props.setSingleNewCaseName).toHaveBeenCalledWith("Theft 2");

    const description = screen.getByPlaceholderText(
      "export.case.newCaseDescriptionPlaceholder",
    );
    expect(description).toHaveValue("Bike");
    fireEvent.change(description, { target: { value: "Blue bike" } });
    expect(props.setSingleNewCaseDescription).toHaveBeenCalledWith("Blue bike");
  });

  it("hides cases from non admins and skips the cases request", () => {
    fixture.admin = false;
    renderContent(contentProps());

    expect(screen.queryByText("export.case.label")).not.toBeInTheDocument();
    expect(fixture.swrKeys).not.toContain("cases");
    expect(fixture.swrKeys).toContain(null);
  });

  it("switches to the multi camera tab with an hour around the playhead", () => {
    const props = contentProps({ selectedCaseId: "c1" });
    renderContent(props);

    fireEvent.mouseDown(
      screen.getByRole("tab", { name: "export.tabs.multiCamera" }),
    );
    expect(props.setRange).toHaveBeenLastCalledWith({
      after: CURRENT - 1800,
      before: CURRENT + 1800,
    });
    expect(props.setBatchCaseSelection).toHaveBeenCalledWith("c1");
    expect(props.setActiveTab).toHaveBeenCalledWith("multi");
  });

  it("defaults the batch case to new when no case was chosen", () => {
    const props = contentProps();
    renderContent(props);
    fireEvent.mouseDown(
      screen.getByRole("tab", { name: "export.tabs.multiCamera" }),
    );
    expect(props.setBatchCaseSelection).toHaveBeenCalledWith("new");
  });
});

describe("ExportContent multi camera tab", () => {
  function multiProps(overrides: WithRange<ContentProps> = {}) {
    return contentProps({ activeTab: "multi", ...overrides });
  }

  it("seeds an hour long range when none is set", () => {
    const props = multiProps({ range: undefined });
    renderContent(props);
    expect(props.setRange).toHaveBeenCalledWith({
      after: CURRENT - 1800,
      before: CURRENT + 1800,
    });
  });

  it("clamps the seeded range to the recorded span", () => {
    const props = multiProps({ range: undefined, currentTime: LATEST - 60 });
    renderContent(props);
    expect(props.setRange).toHaveBeenCalledWith({
      after: LATEST - 60 - 1800,
      before: LATEST,
    });
  });

  it("returns to the export tab and reapplies the preset", () => {
    const props = multiProps();
    renderContent(props);
    fireEvent.mouseDown(
      screen.getByRole("tab", { name: "export.tabs.export" }),
    );
    expect(props.setRange).toHaveBeenLastCalledWith({
      before: LATEST,
      after: LATEST - 3600,
    });
    expect(props.setActiveTab).toHaveBeenCalledWith("export");
  });

  it("shows a loading message while events load", async () => {
    fixture.eventsLoading = true;
    renderContent(multiProps());
    expect(
      await screen.findByText("export.multiCamera.checkingActivity"),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("export.multiCamera.searchOrSelectGroup"),
    ).not.toBeInTheDocument();
  });

  it("shows an empty message without cameras", () => {
    fixture.config = { cameras: {}, camera_groups: {} };
    renderContent(multiProps());
    expect(
      screen.getByText("export.multiCamera.noCameras"),
    ).toBeInTheDocument();
  });

  it("auto selects cameras with activity and draws their segments", async () => {
    const range = { after: LATEST - 1000, before: LATEST };
    fixture.events = [
      {
        camera: "front_door",
        start_time: LATEST - 500,
        end_time: LATEST - 250,
      },
      { camera: "front_door", start_time: LATEST - 900, end_time: null },
      { camera: "_replay_old", start_time: LATEST - 900, end_time: null },
    ];
    renderContent(multiProps({ range }));

    await waitFor(() =>
      expect(cameraCard("Front Door")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(fixture.swrKeys).toContainEqual([
      "events",
      { after: LATEST - 1000, before: LATEST, limit: 500 },
    ]);
    expect(cameraCard("back yard")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("_replay_old")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'export.multiCamera.selectedCount {"selected":1,"total":2}',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('export.multiCamera.detectionCount {"count":2}'),
    ).toBeInTheDocument();

    const segments = Array.from(
      cameraCard("Front Door")?.querySelectorAll<HTMLElement>(
        ".bg-selected.rounded-full",
      ) ?? [],
    );
    expect(segments.map((el) => [el.style.left, el.style.width])).toEqual([
      ["10%", "1%"],
      ["50%", "25%"],
    ]);

    fireEvent.click(cameraCard("back yard") ?? document.body);
    expect(cameraCard("back yard")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(cameraCard("Front Door") ?? document.body);
    expect(cameraCard("Front Door")).toHaveAttribute("aria-pressed", "false");
  });

  it("filters camera cards by id or friendly name", async () => {
    renderContent(multiProps());
    const search = screen.getByPlaceholderText(
      "export.multiCamera.searchOrSelectGroup",
    );

    fireEvent.change(search, { target: { value: "front" } });
    expect(screen.getByText("Front Door")).toBeInTheDocument();
    expect(screen.queryByText("back yard")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "back_" } });
    expect(screen.getByText("back yard")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(
      screen.getByText("export.multiCamera.noMatchingCameras"),
    ).toBeInTheDocument();
  });

  it("applies quick selections and groups from the menu", async () => {
    fixture.events = [
      { camera: "back_yard", start_time: LATEST - 100, end_time: LATEST - 50 },
    ];
    renderContent(
      multiProps({ range: { after: LATEST - 1000, before: LATEST } }),
    );
    await waitFor(() =>
      expect(cameraCard("back yard")).toHaveAttribute("aria-pressed", "true"),
    );

    const search = screen.getByPlaceholderText(
      "export.multiCamera.searchOrSelectGroup",
    );
    fireEvent.focus(search);
    expect(
      screen.getByText("export.multiCamera.selectGroup"),
    ).toBeInTheDocument();
    const groupLabels = screen
      .getAllByText(/^(porch|outside|empty)$/)
      .map((el) => el.textContent);
    expect(groupLabels).toEqual(["porch", "outside"]);

    fireEvent.click(screen.getByText("export.multiCamera.selectAll"));
    expect(cameraCard("Front Door")).toHaveAttribute("aria-pressed", "true");
    expect(cameraCard("back yard")).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByText("export.multiCamera.selectAll"),
    ).not.toBeInTheDocument();

    fireEvent.focus(search);
    fireEvent.click(screen.getByText("export.multiCamera.clearSelection"));
    expect(cameraCard("Front Door")).toHaveAttribute("aria-pressed", "false");
    expect(cameraCard("back yard")).toHaveAttribute("aria-pressed", "false");

    fireEvent.focus(search);
    fireEvent.click(screen.getByText("export.multiCamera.selectWithActivity"));
    expect(cameraCard("back yard")).toHaveAttribute("aria-pressed", "true");
    expect(cameraCard("Front Door")).toHaveAttribute("aria-pressed", "false");

    fireEvent.focus(search);
    fireEvent.click(screen.getByText("porch"));
    expect(cameraCard("Front Door")).toHaveAttribute("aria-pressed", "true");
    expect(cameraCard("back yard")).toHaveAttribute("aria-pressed", "false");

    fireEvent.focus(search);
    fireEvent.click(screen.getByText("outside"));
    expect(cameraCard("back yard")).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the menu when focus leaves and hides it while searching", () => {
    renderContent(multiProps());
    const search = screen.getByPlaceholderText(
      "export.multiCamera.searchOrSelectGroup",
    );

    fireEvent.focus(search);
    expect(
      screen.getByText("export.multiCamera.selectAll"),
    ).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "f" } });
    expect(
      screen.queryByText("export.multiCamera.selectAll"),
    ).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(
      screen.getByText("export.multiCamera.selectAll"),
    ).toBeInTheDocument();

    fireEvent.blur(search, { relatedTarget: document.body });
    expect(
      screen.queryByText("export.multiCamera.selectAll"),
    ).not.toBeInTheDocument();
  });

  it("selects the range from the timeline keeping a valid range", () => {
    const range = { after: LATEST - 600, before: LATEST - 300 };
    const props = multiProps({ range });
    renderContent(props);

    fireEvent.click(
      screen.getByRole("button", {
        name: "export.multiCamera.selectFromTimeline",
      }),
    );
    expect(props.setActiveTab).toHaveBeenCalledWith("multi");
    expect(props.onSelectFromTimeline).toHaveBeenCalledWith(range);
  });

  it("falls back to a minute around the playhead for an unusable range", () => {
    const props = multiProps({
      range: { after: LATEST + 100, before: LATEST + 200 },
    });
    renderContent(props);

    fireEvent.click(
      screen.getByRole("button", {
        name: "export.multiCamera.selectFromTimeline",
      }),
    );
    expect(props.onSelectFromTimeline).toHaveBeenCalledWith({
      after: CURRENT - 30,
      before: CURRENT + 30,
    });
  });

  it("offers only main and auto for a mixed stream selection", async () => {
    renderContent(multiProps());
    expect(screen.queryByText("export.stream.label")).not.toBeInTheDocument();

    fireEvent.click(cameraCard("Front Door") ?? document.body);
    expect(
      screen.getByRole("option", { name: "export.stream.sub" }),
    ).toBeInTheDocument();

    fireEvent.click(cameraCard("back yard") ?? document.body);
    expect(
      screen.queryByRole("option", { name: "export.stream.sub" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "export.stream.main" }),
    ).toBeInTheDocument();
  });

  it("collects the batch name and new case fields", () => {
    const props = multiProps({
      batchCaseSelection: "new",
      newCaseName: "Case",
      newCaseDescription: "Desc",
    });
    renderContent(props);

    fireEvent.change(
      screen.getByPlaceholderText("export.multiCamera.namePlaceholder"),
      { target: { value: "Night" } },
    );
    expect(props.setName).toHaveBeenCalledWith("Night");
    fireEvent.change(
      screen.getByPlaceholderText("export.case.newCaseNamePlaceholder"),
      { target: { value: "Case 2" } },
    );
    expect(props.setNewCaseName).toHaveBeenCalledWith("Case 2");
    fireEvent.change(
      screen.getByPlaceholderText("export.case.newCaseDescriptionPlaceholder"),
      { target: { value: "Desc 2" } },
    );
    expect(props.setNewCaseDescription).toHaveBeenCalledWith("Desc 2");
    fireEvent.click(screen.getByRole("option", { name: "Alpha case" }));
    expect(props.setBatchCaseSelection).toHaveBeenCalledWith("c1");
  });

  function exportButton(count: number) {
    return screen.getByRole("button", {
      name: `export.multiCamera.exportButton {"count":${count}}`,
    });
  }

  it("requires a camera and a new case name before exporting", () => {
    const { rerender } = renderContent(
      multiProps({ batchCaseSelection: "new" }),
    );
    expect(exportButton(0)).toBeDisabled();

    fireEvent.click(cameraCard("Front Door") ?? document.body);
    expect(exportButton(1)).toBeDisabled();

    rerender(
      <ContentHarness
        {...multiProps({ batchCaseSelection: "new", newCaseName: "Case" })}
      />,
    );
    expect(exportButton(1)).toBeEnabled();
  });

  it("queues a batch with a new case and resets on success", async () => {
    axiosPost.mockResolvedValue({
      data: {
        export_case_id: "case-9",
        export_ids: ["e1"],
        results: [{ camera: "front_door", success: true }],
      },
    });
    const props = multiProps({
      name: "Night",
      batchCaseSelection: "new",
      newCaseName: " Case ",
      newCaseDescription: " ",
      stream: "main",
    });
    renderContent(props);
    fireEvent.click(cameraCard("Front Door") ?? document.body);
    fireEvent.click(exportButton(1));

    await waitFor(() => expect(props.setMode).toHaveBeenCalledWith("none"));
    expect(axiosPost).toHaveBeenCalledWith("exports/batch", {
      items: [
        {
          camera: "front_door",
          start_time: LATEST - 3600,
          end_time: LATEST,
          friendly_name: "Night - Front Door",
        },
      ],
      stream: "main",
      new_case_name: "Case",
      new_case_description: undefined,
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      'export.toast.batchQueuedSuccess {"count":1}',
      expect.objectContaining({ position: "top-center" }),
    );
    expect(props.setName).toHaveBeenCalledWith("");
    expect(props.setSelectedCaseId).toHaveBeenCalledWith(undefined);
    expect(props.setBatchCaseSelection).toHaveBeenCalledWith("new");
    expect(props.setNewCaseName).toHaveBeenCalledWith("");
    expect(props.setNewCaseDescription).toHaveBeenCalledWith("");
    expect(props.setRange).toHaveBeenCalledWith(undefined);
    expect(props.setActiveTab).toHaveBeenCalledWith("export");
  });

  it("reports a partial batch and targets an existing case", async () => {
    axiosPost.mockResolvedValue({
      data: {
        export_ids: ["e1"],
        results: [
          { camera: "front_door", success: true },
          { camera: "back_yard", success: false, error: "no recordings" },
        ],
      },
    });
    const props = multiProps({ batchCaseSelection: "c1" });
    renderContent(props);
    fireEvent.click(cameraCard("Front Door") ?? document.body);
    fireEvent.click(cameraCard("back yard") ?? document.body);
    fireEvent.click(exportButton(2));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(axiosPost).toHaveBeenCalledWith(
      "exports/batch",
      expect.objectContaining({
        export_case_id: "c1",
        items: [
          expect.objectContaining({
            camera: "front_door",
            friendly_name: undefined,
          }),
          expect.objectContaining({ camera: "back_yard" }),
        ],
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      'export.toast.batchQueuedPartial {"successful":1,"total":2,"failedCameras":"back yard"}',
      expect.objectContaining({
        description: "back yard: no recordings",
        action: undefined,
      }),
    );
    expect(props.setMode).toHaveBeenCalledWith("none");
  });

  it("reports a fully failed batch without resetting", async () => {
    axiosPost.mockResolvedValue({
      data: {
        export_ids: [],
        results: [{ camera: "front_door", success: false }],
      },
    });
    const props = multiProps({ batchCaseSelection: "none" });
    renderContent(props);
    fireEvent.click(cameraCard("Front Door") ?? document.body);
    fireEvent.click(exportButton(1));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith(
      'export.toast.batchQueueFailed {"total":1,"failedCameras":"Front Door"}',
      { position: "top-center", description: "Front Door" },
    );
    const body = axiosPost.mock.calls[0]?.[1];
    expect(body).not.toHaveProperty("export_case_id");
    expect(body).not.toHaveProperty("new_case_name");
    expect(props.setMode).not.toHaveBeenCalled();
  });

  it("omits case fields for non admins", async () => {
    fixture.admin = false;
    axiosPost.mockResolvedValue({
      data: {
        export_ids: ["e"],
        results: [{ camera: "front_door", success: true }],
      },
    });
    renderContent(multiProps({ batchCaseSelection: "c1" }));
    fireEvent.click(cameraCard("Front Door") ?? document.body);
    fireEvent.click(exportButton(1));

    await waitFor(() => expect(axiosPost).toHaveBeenCalled());
    expect(axiosPost.mock.calls[0]?.[1]).not.toHaveProperty("export_case_id");
  });

  it("shows the queueing label while the batch is in flight and reports errors", async () => {
    let reject: (reason: unknown) => void = () => undefined;
    axiosPost.mockReturnValue(
      new Promise((_resolve, rej) => {
        reject = rej;
      }),
    );
    renderContent(multiProps({ batchCaseSelection: "none" }));
    fireEvent.click(cameraCard("Front Door") ?? document.body);
    fireEvent.click(exportButton(1));

    expect(
      await screen.findByText("export.multiCamera.queueingButton"),
    ).toBeInTheDocument();
    await act(async () => {
      reject({ response: { data: { detail: "disk full" } } });
    });

    expect(toastError).toHaveBeenCalledWith(
      'export.toast.error.failed {"error":"disk full"}',
      { position: "top-center" },
    );
    expect(exportButton(1)).toBeEnabled();
  });

  it("falls back to an unknown error message", async () => {
    axiosPost.mockRejectedValue(new Error("boom"));
    renderContent(multiProps({ batchCaseSelection: "none" }));
    fireEvent.click(cameraCard("Front Door") ?? document.body);
    fireEvent.click(exportButton(1));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'export.toast.error.failed {"error":"Unknown error"}',
        { position: "top-center" },
      ),
    );
  });
});

describe("ExportPreviewDialog", () => {
  it("renders nothing without a range", () => {
    const { container } = render(
      <ExportPreviewDialog
        camera="front_door"
        showPreview
        setShowPreview={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("plays the selected range from the vod endpoint", () => {
    render(
      <ExportPreviewDialog
        camera="front_door"
        range={{ after: 100, before: 200 }}
        showPreview
        setShowPreview={vi.fn()}
      />,
    );
    expect(screen.getByTestId("video-player")).toHaveTextContent(
      "vod/front_door/start/100/end/200/index.m3u8",
    );
    expect(
      screen.getAllByText("export.fromTimeline.previewExport").length,
    ).toBeGreaterThan(0);
  });
});

describe("ExportDialog", () => {
  function exportAction() {
    return screen.getByRole("button", { name: "export.selectOrExport" });
  }

  it("stays closed when not selecting", () => {
    renderDialog(dialogProps({ mode: "none" }));
    expect(screen.queryByText("menu.export")).not.toBeInTheDocument();
    expect(screen.queryByTestId("save-overlay")).not.toBeInTheDocument();
  });

  it("rejects an export without a range", async () => {
    renderDialog(dialogProps({ range: undefined }));
    fireEvent.click(exportAction());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "export.toast.error.noValidTimeSelected",
        { position: "top-center" },
      ),
    );
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it("rejects an inverted range", async () => {
    renderDialog(dialogProps({ range: { after: 200, before: 100 } }));
    fireEvent.click(exportAction());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "export.toast.error.endTimeMustAfterStartTime",
        { position: "top-center" },
      ),
    );
  });

  it("queues a single export and closes", async () => {
    const props = dialogProps({ range: { after: 100.4, before: 199.6 } });
    renderDialog(props);
    fireEvent.change(screen.getByPlaceholderText("export.name.placeholder"), {
      target: { value: "Porch" },
    });
    fireEvent.click(screen.getByRole("option", { name: "Alpha case" }));
    fireEvent.click(exportAction());

    await waitFor(() => expect(props.setMode).toHaveBeenCalledWith("none"));
    expect(axiosPost).toHaveBeenCalledWith(
      "export/front_door/start/100/end/200",
      {
        source: "recordings",
        name: "Porch",
        export_case_id: "c1",
        stream: "auto",
      },
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      "export.toast.queued",
      expect.objectContaining({ position: "top-center" }),
    );
    expect(props.setRange).toHaveBeenCalledWith(undefined);
  });

  it("creates a new case before exporting into it", async () => {
    axiosPost.mockImplementation((url: string) =>
      Promise.resolve(
        url === "cases" ? { data: { id: "case-new" } } : { data: {} },
      ),
    );
    renderDialog(dialogProps());
    fireEvent.click(
      screen.getByRole("option", { name: "export.case.newCaseOption" }),
    );
    fireEvent.change(
      screen.getByPlaceholderText("export.case.newCaseNamePlaceholder"),
      { target: { value: " Break in " } },
    );
    fireEvent.change(
      screen.getByPlaceholderText("export.case.newCaseDescriptionPlaceholder"),
      { target: { value: " Side door " } },
    );
    fireEvent.click(exportAction());

    await waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(2));
    expect(axiosPost).toHaveBeenNthCalledWith(1, "cases", {
      name: "Break in",
      description: "Side door",
    });
    expect(axiosPost).toHaveBeenNthCalledWith(
      2,
      `export/front_door/start/${LATEST - 3600}/end/${LATEST}`,
      expect.objectContaining({ export_case_id: "case-new" }),
    );
  });

  it("drops an unnamed new case", async () => {
    renderDialog(dialogProps());
    fireEvent.click(
      screen.getByRole("option", { name: "export.case.newCaseOption" }),
    );
    fireEvent.click(exportAction());

    await waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1));
    expect(axiosPost.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ export_case_id: undefined }),
    );
  });

  it("reports a failed export with the server message", async () => {
    axiosPost.mockRejectedValue({ response: { data: { message: "busy" } } });
    const props = dialogProps();
    renderDialog(props);
    fireEvent.click(exportAction());

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'export.toast.error.failed {"error":"busy"}',
        { position: "top-center" },
      ),
    );
    expect(props.setMode).not.toHaveBeenCalled();
  });

  it("falls back to an unknown error for a single export", async () => {
    axiosPost.mockRejectedValue(new Error("network"));
    renderDialog(dialogProps());
    fireEvent.click(exportAction());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'export.toast.error.failed {"error":"Unknown error"}',
        { position: "top-center" },
      ),
    );
  });

  it("clears everything on cancel", () => {
    const props = dialogProps();
    renderDialog(props);
    fireEvent.click(screen.getByRole("button", { name: "button.cancel" }));
    expect(props.setMode).toHaveBeenCalledWith("none");
    expect(props.setRange).toHaveBeenCalledWith(undefined);
  });

  it("saves from the timeline overlay", async () => {
    const props = dialogProps({ mode: "timeline" });
    renderDialog(props);

    expect(screen.getByTestId("save-overlay-label")).toHaveTextContent(
      "default-save",
    );
    expect(screen.getByTestId("save-overlay-hide-preview")).toHaveTextContent(
      "false",
    );
    fireEvent.click(screen.getByText("overlay-preview"));
    expect(props.setShowPreview).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByText("overlay-save"));
    await waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(props.setMode).toHaveBeenCalledWith("none"));
  });

  it("cancels the timeline overlay", () => {
    const props = dialogProps({ mode: "timeline" });
    renderDialog(props);
    fireEvent.click(screen.getByText("overlay-cancel"));
    expect(props.setMode).toHaveBeenCalledWith("none");
    expect(props.setRange).toHaveBeenCalledWith(undefined);
  });

  it("round trips a multi camera range through the timeline", () => {
    const original = { after: LATEST - 900, before: LATEST - 300 };
    const props = dialogProps({ range: original });
    const view = renderDialog(props);

    fireEvent.mouseDown(
      screen.getByRole("tab", { name: "export.tabs.multiCamera" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "export.multiCamera.selectFromTimeline",
      }),
    );
    expect(props.setRange).toHaveBeenLastCalledWith(original);
    expect(props.setMode).toHaveBeenLastCalledWith("timeline_multi");

    const timelineProps: DialogProps = { ...props, mode: "timeline_multi" };
    view.rerenderWith(timelineProps);
    expect(screen.getByTestId("save-overlay-label")).toHaveTextContent(
      "export.fromTimeline.useThisRange",
    );
    expect(screen.getByTestId("save-overlay-hide-preview")).toHaveTextContent(
      "true",
    );

    fireEvent.click(screen.getByText("overlay-cancel"));
    expect(props.setRange).toHaveBeenLastCalledWith(original);
    expect(props.setMode).toHaveBeenLastCalledWith("select");

    fireEvent.click(screen.getByText("overlay-save"));
    expect(props.setMode).toHaveBeenLastCalledWith("select");
    expect(axiosPost).not.toHaveBeenCalled();

    view.rerenderWith({ ...props, mode: "select" });
    expect(
      screen.getByRole("tab", { name: "export.tabs.multiCamera" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("returns to the single export tab after closing", () => {
    const props = dialogProps({ mode: "timeline_multi" });
    const view = renderDialog(props);
    const modes: ExportMode[] = ["select", "none", "select"];
    for (const mode of modes) {
      view.rerenderWith({ ...props, mode });
    }
    expect(
      screen.getByRole("tab", { name: "export.tabs.export" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("opens from the mobile trigger with the last hour", () => {
    fixture.desktop = false;
    const props = dialogProps({ mode: "none" });
    renderDialog(props);

    fireEvent.click(screen.getByRole("button", { name: "menu.export" }));
    expect(props.setRange).toHaveBeenCalledWith({
      before: LATEST,
      after: LATEST - 3600,
    });
    expect(props.setMode).toHaveBeenCalledWith("select");
  });
});
