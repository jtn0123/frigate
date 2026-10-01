import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { SearchFilter } from "@/types/search";
import { createConfigFixture } from "@/utils/fork/config.test-fixture";
import SearchFilterDialog from "../SearchFilterDialog";

type Fixture = {
  subLabels: string[] | undefined;
  attributes: string[] | undefined;
  plates: string[] | undefined;
  swrKeys: unknown[];
};

const fixture = vi.hoisted((): Fixture => ({
  subLabels: [],
  attributes: undefined,
  plates: undefined,
  swrKeys: [],
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) => {
      const rest = { ...options };
      delete rest["ns"];
      return Object.keys(rest).length > 0
        ? `${key} ${JSON.stringify(rest)}`
        : key;
    },
  }),
}));
vi.mock("swr", () => ({
  default: (key: unknown) => {
    fixture.swrKeys.push(key);
    if (Array.isArray(key) && key[0] === "sub_labels") {
      return { data: fixture.subLabels };
    }
    if (key === "classification/attributes") {
      return { data: fixture.attributes };
    }
    if (key === "recognized_license_plates") {
      return { data: fixture.plates };
    }
    return { data: undefined };
  },
}));
vi.mock("react-device-detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-device-detect")>()),
  isDesktop: true,
  isMobile: false,
}));
vi.mock("@/hooks/use-date-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-date-utils")>()),
  useFormattedHour: (_config: unknown, time: string) => `hour:${time}`,
}));
vi.mock("@/components/camera/FriendlyNameLabel", () => ({
  CameraNameLabel: ({
    camera,
    htmlFor,
  }: {
    camera?: string;
    htmlFor?: string;
  }) => <label htmlFor={htmlFor}>{`camera-name:${camera ?? ""}`}</label>,
  ZoneNameLabel: ({ zone, htmlFor }: { zone: string; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{`zone-name:${zone}`}</label>
  ),
}));
vi.mock("@/components/ui/slider", () => ({
  DualThumbSlider: ({
    min = 0,
    max = 0,
    step = 0,
    onValueChange,
  }: {
    min?: number;
    max?: number;
    step?: number;
    onValueChange?: (value: number[]) => void;
  }) => (
    <button
      type="button"
      onClick={() => onValueChange?.([min + step, max - step])}
    >
      {`slider ${min}-${max}`}
    </button>
  ),
}));
vi.mock("../PlatformAwareDialog", () => ({
  PlatformAwareSheet: ({
    trigger,
    title,
    content,
    open,
    onOpenChange,
  }: {
    trigger: ReactElement;
    title?: string | ReactElement;
    content: ReactElement;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div>
      {trigger}
      <button type="button" onClick={() => onOpenChange(true)}>
        open-sheet
      </button>
      {open && (
        <div role="dialog">
          <h2>{title}</h2>
          {content}
          <button type="button" onClick={() => onOpenChange(false)}>
            close-sheet
          </button>
        </div>
      )}
    </div>
  ),
}));

type Props = ComponentProps<typeof SearchFilterDialog>;

const filterValues: Props["filterValues"] = {
  cameras: ["front_door"],
  labels: ["person"],
  zones: ["yard", "porch"],
  search_type: ["thumbnail"],
};

function makeConfig(options: {
  metric?: boolean;
  plus?: boolean;
  custom?: boolean;
}): FrigateConfig {
  const config = createConfigFixture();
  config.ui = {
    dashboard: true,
    review: true,
    order: 0,
    unit_system: options.metric ? "metric" : "imperial",
  };
  config.plus = { enabled: options.plus ?? false };
  config.classification = {
    bird: { enabled: false, threshold: 0.9 },
    custom: options.custom
      ? { model: { enabled: true, name: "model", threshold: 0.8 } }
      : {},
  };
  return config;
}

function renderDialog(overrides: Partial<Props> = {}) {
  const props = {
    filterValues,
    ...overrides,
    onUpdateFilter: vi.fn<(filter: SearchFilter) => void>(),
  };
  const utils = render(<SearchFilterDialog {...props} />);
  return { ...utils, props };
}

function open() {
  expect(screen.getByRole("button", { name: "more" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "open-sheet" }));
}

function apply() {
  fireEvent.click(screen.getByRole("button", { name: "button.apply" }));
}

function timeInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="time"]');
  if (!input) throw new Error("time input not open");
  return input;
}

function radio(name: string, index: number): HTMLElement {
  const item = screen.getAllByRole("radio", { name })[index];
  if (!item) throw new Error(`no ${name} radio at ${index}`);
  return item;
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
});

beforeEach(() => {
  fixture.subLabels = [];
  fixture.attributes = undefined;
  fixture.plates = undefined;
  fixture.swrKeys = [];
});

describe("SearchFilterDialog trigger", () => {
  it("is neutral without extra filters and highlighted with them", () => {
    const { rerender, props } = renderDialog();
    const icon = () =>
      screen.getByRole("button", { name: "more" }).querySelector("svg");
    expect(icon()).toHaveClass("text-secondary-foreground");
    rerender(<SearchFilterDialog {...props} filter={{ zones: ["yard"] }} />);
    expect(icon()).toHaveClass("text-white");
  });

  it.each<[string, SearchFilter]>([
    ["time range", { time_range: "01:00,02:00" }],
    ["min score", { min_score: 0.7 }],
    ["max score", { max_score: 0.9 }],
    ["min speed", { min_speed: 5 }],
    ["max speed", { max_speed: 20 }],
    ["snapshot", { has_snapshot: 1 }],
    ["clip", { has_clip: 1 }],
    ["sub labels", { sub_labels: ["bob"] }],
    ["plates", { recognized_license_plate: ["ABC"] }],
  ])("highlights for %s", (_name, filter) => {
    renderDialog({ filter });
    expect(
      screen.getByRole("button", { name: "more" }).querySelector("svg"),
    ).toHaveClass("text-white");
  });

  it("only counts attributes when custom models exist", () => {
    const filter: SearchFilter = { attributes: ["red"] };
    const { rerender, props } = renderDialog({ filter });
    const icon = () =>
      screen.getByRole("button", { name: "more" }).querySelector("svg");
    expect(icon()).toHaveClass("text-secondary-foreground");
    rerender(
      <SearchFilterDialog
        {...props}
        filter={filter}
        config={makeConfig({ custom: true })}
      />,
    );
    expect(icon()).toHaveClass("text-white");
    expect(fixture.swrKeys).toContain("classification/attributes");
  });
});

describe("SearchFilterDialog content", () => {
  it("renders every section and applies an unchanged filter", () => {
    fixture.plates = undefined;
    const { props } = renderDialog({ filter: { cameras: ["front_door"] } });
    open();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("timeRange");
    expect(dialog).toHaveTextContent("zones.label");
    expect(dialog).toHaveTextContent("subLabels.label");
    expect(dialog).toHaveTextContent("recognizedLicensePlates.loading");
    expect(dialog).toHaveTextContent("score");
    expect(dialog).toHaveTextContent(
      'estimatedSpeed {"unit":"unit.speed.mph"}',
    );
    expect(dialog).toHaveTextContent("features.label");
    expect(dialog).not.toHaveTextContent("attributes.label");
    expect(fixture.swrKeys).not.toContain("classification/attributes");
    apply();
    expect(props.onUpdateFilter).toHaveBeenCalledWith({
      cameras: ["front_door"],
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses metric units and hides plates when none exist", () => {
    fixture.plates = [];
    renderDialog({ config: makeConfig({ metric: true }) });
    open();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      'estimatedSpeed {"unit":"unit.speed.kph"}',
    );
    expect(dialog).not.toHaveTextContent("recognizedLicensePlates.title");
  });

  it("edits the time range through the start and end pickers", () => {
    const { props } = renderDialog();
    open();
    expect(
      screen.getByRole("button", { name: "export.time.start.label" }),
    ).toHaveTextContent("hour:00:00");
    fireEvent.click(
      screen.getByRole("button", { name: "export.time.start.label" }),
    );
    fireEvent.change(timeInput(), { target: { value: "08:30" } });
    expect(
      screen.getByRole("button", { name: "export.time.start.label" }),
    ).toHaveTextContent("hour:08:30");

    fireEvent.click(
      screen.getByRole("button", { name: "export.time.end.label" }),
    );
    expect(timeInput()).toHaveValue("23:59");
    fireEvent.change(timeInput(), { target: { value: "17:15" } });
    apply();
    expect(props.onUpdateFilter).toHaveBeenCalledWith({
      time_range: "08:30,17:15",
    });
  });

  it("shows an existing time range and caps 24:00 in the end picker", () => {
    renderDialog({ filter: { time_range: "06:00,24:00" } });
    open();
    expect(
      screen.getByRole("button", { name: "export.time.start.label" }),
    ).toHaveTextContent("hour:06:00");
    fireEvent.click(
      screen.getByRole("button", { name: "export.time.end.label" }),
    );
    expect(timeInput()).toHaveValue("23:59");
  });

  it("selects zones, keeps the last zone and resets to all zones", () => {
    const { props } = renderDialog();
    open();
    const allZones = screen.getByRole("switch", { name: "zones.all.title" });
    expect(allZones).toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "zone-name:yard" }));
    fireEvent.click(screen.getByRole("switch", { name: "zone-name:porch" }));
    expect(allZones).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "zone-name:yard" }));
    fireEvent.click(screen.getByRole("switch", { name: "zone-name:porch" }));
    expect(
      screen.getByRole("switch", { name: "zone-name:porch" }),
    ).toBeChecked();
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      zones: ["porch"],
    });

    open();
    fireEvent.click(screen.getByRole("switch", { name: "zones.all.title" }));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({});
  });

  it("sorts sub labels and toggles them", () => {
    fixture.subLabels = ["zed", "Bob_Smith", "alice"];
    const { props } = renderDialog();
    open();
    const names = screen
      .getAllByRole("switch")
      .map((item) => item.getAttribute("id"));
    expect(names).toEqual(
      expect.arrayContaining(["alice", "Bob Smith", "zed"]),
    );
    expect(names.indexOf("alice")).toBeLessThan(names.indexOf("Bob Smith"));
    expect(names.indexOf("Bob Smith")).toBeLessThan(names.indexOf("zed"));

    fireEvent.click(screen.getByRole("switch", { name: "alice" }));
    fireEvent.click(screen.getByRole("switch", { name: "zed" }));
    fireEvent.click(screen.getByRole("switch", { name: "alice" }));
    fireEvent.click(screen.getByRole("switch", { name: "zed" }));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      sub_labels: ["zed"],
    });

    open();
    fireEvent.click(screen.getByRole("switch", { name: "subLabels.all" }));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({});
  });

  it("filters by custom classification attributes", () => {
    fixture.attributes = ["red_hat", "Blue"];
    const { props } = renderDialog({ config: makeConfig({ custom: true }) });
    open();
    expect(screen.getByRole("dialog")).toHaveTextContent("attributes.label");
    fireEvent.click(screen.getByRole("switch", { name: "red hat" }));
    fireEvent.click(screen.getByRole("switch", { name: "Blue" }));
    fireEvent.click(screen.getByRole("switch", { name: "red hat" }));
    fireEvent.click(screen.getByRole("switch", { name: "Blue" }));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      attributes: ["Blue"],
    });

    open();
    fireEvent.click(screen.getByRole("switch", { name: "attributes.all" }));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({});
  });

  it("updates the score range from inputs and slider", () => {
    const { props } = renderDialog();
    open();
    fireEvent.change(screen.getByDisplayValue("50"), {
      target: { value: "70" },
    });
    fireEvent.change(screen.getByDisplayValue("100"), {
      target: { value: "90" },
    });
    fireEvent.change(screen.getByDisplayValue("90"), { target: { value: "" } });
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      min_score: 0.7,
      max_score: 0.9,
    });

    open();
    fireEvent.click(screen.getByRole("button", { name: "slider 0.5-1" }));
    apply();
    const last = props.onUpdateFilter.mock.lastCall?.[0];
    expect(last?.min_score).toBeCloseTo(0.51);
    expect(last?.max_score).toBeCloseTo(0.99);
  });

  it("updates the speed range from inputs and slider", () => {
    const { props } = renderDialog({ filter: { max_speed: 120 } });
    open();
    fireEvent.change(screen.getByDisplayValue("1"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByDisplayValue("120"), {
      target: { value: "60" },
    });
    fireEvent.change(screen.getByDisplayValue("60"), { target: { value: "" } });
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      min_speed: 5,
      max_speed: 60,
    });

    open();
    fireEvent.click(screen.getByRole("button", { name: "slider 1-150" }));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      min_speed: 2,
      max_speed: 149,
    });
  });

  it("keeps the 150 upper bound when only the min speed is typed", () => {
    const { props } = renderDialog();
    open();
    fireEvent.change(screen.getByDisplayValue("1"), {
      target: { value: "10" },
    });
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      min_speed: 10,
      max_speed: 150,
    });
  });

  it("opens while the sub label list is loading or failed", () => {
    fixture.subLabels = undefined;
    renderDialog();
    open();
    expect(screen.getByRole("dialog")).toHaveTextContent("subLabels.label");
    expect(
      screen.getByRole("switch", { name: "subLabels.all" }),
    ).toBeInTheDocument();
  });

  it("resets the extra filters but keeps the others", () => {
    const filter: SearchFilter = {
      cameras: ["front_door"],
      zones: ["yard"],
      min_score: 0.7,
      max_speed: 30,
      has_clip: 1,
      recognized_license_plate: ["ABC"],
    };
    const { props } = renderDialog({
      filter,
      config: makeConfig({ custom: true }),
    });
    open();
    fireEvent.click(screen.getByRole("button", { name: "reset.label" }));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      cameras: ["front_door"],
    });
  });

  it("discards edits when the sheet closes without applying", () => {
    const { props } = renderDialog({ filter: { labels: ["person"] } });
    open();
    fireEvent.click(screen.getByRole("switch", { name: "zone-name:yard" }));
    fireEvent.click(screen.getByRole("button", { name: "close-sheet" }));
    expect(props.onUpdateFilter).not.toHaveBeenCalled();
    open();
    expect(
      screen.getByRole("switch", { name: "zone-name:yard" }),
    ).not.toBeChecked();
  });

  it("syncs with a new filter prop", () => {
    const { props, rerender } = renderDialog({ filter: { zones: ["yard"] } });
    rerender(<SearchFilterDialog {...props} filter={{ zones: ["porch"] }} />);
    open();
    expect(
      screen.getByRole("switch", { name: "zone-name:porch" }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "zone-name:yard" }),
    ).not.toBeChecked();
  });
});

describe("SearchFilterDialog features", () => {
  it("toggles the snapshot filter and its yes or no value", () => {
    const { props } = renderDialog();
    open();
    const snapshot = screen.getByRole("checkbox", {
      name: "features.hasSnapshot",
    });
    fireEvent.click(snapshot);
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({ has_snapshot: 1 });

    open();
    fireEvent.click(radio("button.no", 0));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({ has_snapshot: 0 });

    open();
    fireEvent.click(radio("button.yes", 0));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "features.hasSnapshot" }),
    );
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({});
  });

  it("toggles the clip filter and its yes or no value", () => {
    const { props } = renderDialog();
    open();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "features.hasVideoClip" }),
    );
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({ has_clip: 1 });

    open();
    fireEvent.click(radio("button.no", 1));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({ has_clip: 0 });

    open();
    fireEvent.click(radio("button.yes", 1));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({ has_clip: 1 });

    open();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "features.hasVideoClip" }),
    );
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({});
  });

  it("gates the Frigate+ filter on an active snapshot filter", () => {
    const { props } = renderDialog({ config: makeConfig({ plus: true }) });
    open();
    const plus = () =>
      screen.getByRole("checkbox", {
        name: "features.submittedToFrigatePlus.label",
      });
    expect(plus()).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "features.hasSnapshot" }),
    );
    expect(plus()).toBeEnabled();
    fireEvent.click(plus());
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      has_snapshot: 1,
      is_submitted: 0,
    });

    open();
    fireEvent.click(radio("button.yes", 1));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      has_snapshot: 1,
      is_submitted: 1,
    });

    open();
    fireEvent.click(radio("button.yes", 1));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      has_snapshot: 1,
    });

    open();
    fireEvent.click(radio("button.no", 1));
    expect(radio("button.no", 1)).toBeDisabled();
    fireEvent.click(plus());
    fireEvent.click(plus());
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      has_snapshot: 1,
    });
  });

  it("clears the Frigate+ value when snapshots are set to no", () => {
    const { props } = renderDialog({
      config: makeConfig({ plus: true }),
      filter: { has_snapshot: 1, is_submitted: 1 },
    });
    open();
    expect(
      screen.getByRole("checkbox", {
        name: "features.submittedToFrigatePlus.label",
      }),
    ).toBeChecked();
    fireEvent.click(radio("button.no", 0));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({ has_snapshot: 0 });
  });
});

describe("SearchFilterDialog license plates", () => {
  beforeEach(() => {
    fixture.plates = ["ABC123", "ABD000", "XYZ789"];
  });

  function option(name: string) {
    return screen.getByRole("option", { name });
  }

  function plateSearch(value: string) {
    fireEvent.change(
      screen.getByPlaceholderText("recognizedLicensePlates.placeholder"),
      { target: { value } },
    );
  }

  it("selects and deselects plates from the list and chips", () => {
    const { props } = renderDialog();
    open();
    fireEvent.click(option("ABC123"));
    fireEvent.click(option("XYZ789"));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      recognized_license_plate: ["ABC123", "XYZ789"],
    });

    open();
    const [firstChip] = screen.getAllByRole("button", { name: "×" });
    if (!firstChip) throw new Error("no plate chip");
    expect(firstChip.parentElement).toHaveTextContent("ABC123");
    fireEvent.click(firstChip);
    fireEvent.click(option("XYZ789"));
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({});
  });

  it("selects every visible plate for a wildcard search and clears all", () => {
    const { props } = renderDialog();
    open();
    plateSearch("ab*");
    expect(screen.queryByRole("option", { name: "XYZ789" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "recognizedLicensePlates.selectAll" }),
    );
    expect(
      screen.queryByRole("button", {
        name: "recognizedLicensePlates.selectAll",
      }),
    ).toBeNull();
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      recognized_license_plate: ["ABC123", "ABD000"],
    });

    open();
    fireEvent.click(
      screen.getByRole("button", { name: "recognizedLicensePlates.clearAll" }),
    );
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({});
  });

  it("matches single character wildcards, regex and substrings", () => {
    renderDialog();
    open();
    plateSearch("ABD00?");
    expect(option("ABD000")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "ABC123" })).toBeNull();

    plateSearch("/^x/");
    expect(option("XYZ789")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "ABD000" })).toBeNull();

    plateSearch("c12");
    expect(option("ABC123")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "XYZ789" })).toBeNull();
  });

  it("shows the empty state for an invalid regex", () => {
    renderDialog();
    open();
    plateSearch("/[/");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(
      screen.getByText("recognizedLicensePlates.noLicensePlatesFound"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "recognizedLicensePlates.selectAll",
      }),
    ).toBeNull();
  });

  it("deselects the visible plates when all of them are already chosen", () => {
    const { props } = renderDialog({
      filter: { recognized_license_plate: ["ABC123"] },
    });
    open();
    plateSearch("ABC");
    expect(
      screen.queryByRole("button", {
        name: "recognizedLicensePlates.selectAll",
      }),
    ).toBeNull();
    plateSearch("");
    fireEvent.click(
      screen.getByRole("button", { name: "recognizedLicensePlates.selectAll" }),
    );
    apply();
    expect(props.onUpdateFilter).toHaveBeenLastCalledWith({
      recognized_license_plate: ["ABC123", "ABD000", "XYZ789"],
    });
  });
});
