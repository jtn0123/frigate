import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, SetStateAction } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SavedSearchQuery, SearchFilter } from "@/types/search";
import { convertLocalDateToTimestamp } from "@/utils/dateUtil";
import InputWithTags from "../InputWithTags";

type AudioConfig = {
  cameras: Record<string, { audio: { enabled: boolean; listen: string[] } }>;
  ui: { unit_system: "metric" | "imperial" };
};

type Fixture = {
  config: AudioConfig | undefined;
  is24Hour: boolean;
  language: string;
  history: SavedSearchQuery[] | undefined;
  loaded: boolean;
  setHistory: (value: SavedSearchQuery[] | undefined) => void;
  toastError: (message: string, options?: Record<string, unknown>) => void;
  toastSuccess: (message: string, options?: Record<string, unknown>) => void;
};

const fixture = vi.hoisted((): Fixture => ({
  config: undefined,
  is24Hour: true,
  language: "en",
  history: undefined,
  loaded: true,
  setHistory: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: fixture.language },
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
  default: () => ({ data: fixture.config }),
}));
vi.mock("sonner", () => ({
  toast: {
    error: (message: string, options?: Record<string, unknown>) =>
      fixture.toastError(message, options),
    success: (message: string, options?: Record<string, unknown>) =>
      fixture.toastSuccess(message, options),
  },
}));
vi.mock("@/hooks/use-date-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-date-utils")>()),
  use24HourTime: () => fixture.is24Hour,
}));
vi.mock("@/utils/i18n", () => ({
  getTranslatedLabel: (label: string, type: string) => `${type}:${label}`,
}));
vi.mock("@/components/camera/FriendlyNameLabel", () => ({
  CameraNameLabel: ({ camera }: { camera?: string }) => (
    <span>{`camera-name:${camera ?? ""}`}</span>
  ),
  ZoneNameLabel: ({ zone }: { zone: string }) => (
    <span>{`zone-name:${zone}`}</span>
  ),
}));
vi.mock("@/hooks/use-user-persistence", async () => {
  const React = await import("react");
  return {
    useUserPersistence: () => {
      const [value, setValue] = React.useState(fixture.history);
      const set = (next: SavedSearchQuery[] | undefined) => {
        fixture.setHistory(next);
        setValue(next);
      };
      return [value, set, fixture.loaded, () => undefined];
    },
  };
});

type Props = ComponentProps<typeof InputWithTags>;

const allSuggestions: Props["allSuggestions"] = {
  cameras: ["front_door", "back_yard"],
  labels: ["person", "bark"],
  zones: ["yard"],
  sub_labels: ["bob"],
  search_type: ["thumbnail", "description"],
  before: [],
  after: [],
  time_range: ["15:00-16:00"],
  min_score: [],
  max_score: [],
  min_speed: [],
  max_speed: [],
  has_snapshot: ["yes", "no"],
  has_clip: ["yes", "no"],
  is_submitted: ["yes", "no"],
  sort: ["date_asc", "date_desc"],
  event_id: ["abc"],
};

function makeConfig(unitSystem: "metric" | "imperial"): AudioConfig {
  return {
    cameras: {
      front_door: { audio: { enabled: true, listen: ["bark"] } },
      back_yard: { audio: { enabled: false, listen: ["speech"] } },
    },
    ui: { unit_system: unitSystem },
  };
}

function renderInput(overrides: Partial<Props> = {}) {
  const props = {
    inputFocused: false,
    setInputFocused: vi.fn<(value: SetStateAction<boolean>) => void>(),
    filters: {},
    setFilters: vi.fn<(filter: SearchFilter) => void>(),
    search: "",
    setSearch: vi.fn<(search: string) => void>(),
    allSuggestions,
    ...overrides,
  };
  const utils = render(
    <TooltipProvider>
      <InputWithTags {...props} />
    </TooltipProvider>,
  );
  const input = screen.getByPlaceholderText("placeholder.search");
  return { ...utils, props, input };
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

function tooltipIcon(container: HTMLElement, index: number): SVGElement {
  const triggers = container.querySelectorAll(
    "div.absolute > button[data-state]",
  );
  const svg = triggers[index]?.querySelector("svg");
  if (!svg) throw new Error(`no tooltip icon at ${index}`);
  return svg;
}

function chevron(container: HTMLElement): SVGElement {
  const svg = container.querySelector<SVGElement>("div.absolute > svg");
  if (!svg) throw new Error("no chevron");
  return svg;
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  fixture.config = undefined;
  fixture.is24Hour = true;
  fixture.language = "en";
  fixture.history = undefined;
  fixture.loaded = true;
});

describe("InputWithTags basics", () => {
  it("lists available filter types and hides the clear and save icons without input", () => {
    const { container } = renderInput();
    expect(screen.getByText("filter.header.noFilters")).toBeInTheDocument();
    expect(screen.getByText("cameras")).toBeInTheDocument();
    expect(screen.getByText("sort")).toBeInTheDocument();
    expect(
      container.querySelectorAll("div.absolute > button[data-state]"),
    ).toHaveLength(1);
  });

  it("toggles focus through the chevron, focus and blur handlers", () => {
    const { container, props, input } = renderInput();
    fireEvent.click(chevron(container));
    expect(props.setInputFocused).toHaveBeenLastCalledWith(true);
    fireEvent.focus(input);
    expect(props.setInputFocused).toHaveBeenLastCalledWith(true);
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(props.setInputFocused).toHaveBeenLastCalledWith(false);
  });

  it("collapses through the up chevron when focused", () => {
    const { container, props } = renderInput({ inputFocused: true });
    fireEvent.click(chevron(container));
    expect(props.setInputFocused).toHaveBeenCalledWith(false);
  });

  it("does not lose focus when blur moves inside the command list", () => {
    const { props, input } = renderInput();
    const option = screen.getByText("cameras");
    fireEvent.blur(input, { relatedTarget: option });
    expect(props.setInputFocused).not.toHaveBeenCalled();
  });

  it("searches free text on Enter and from the search item", () => {
    const { props, input } = renderInput();
    type(input, "red car");
    expect(
      screen.getByText('searchFor {"inputValue":"red car"}'),
    ).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.setSearch).toHaveBeenCalledWith("red car");
    expect(props.setInputFocused).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByText('searchFor {"inputValue":"red car"}'));
    expect(props.setSearch).toHaveBeenCalledTimes(2);
  });

  it("narrows filter type suggestions to the current word", () => {
    const { input } = renderInput();
    type(input, "cam");
    expect(screen.getByText("cameras")).toBeInTheDocument();
    expect(screen.queryByText("labels")).not.toBeInTheDocument();
  });

  it("narrows suggestions whatever the case of the typed word", () => {
    const { input } = renderInput();
    type(input, "dog Cam");
    expect(screen.getByText("cameras")).toBeInTheDocument();
    expect(screen.queryByText("labels")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("cameras"));
    expect(input).toHaveValue("dog cameras:");
  });

  it("shows every suggestion again after a trailing space", () => {
    const { input } = renderInput();
    type(input, "cam ");
    expect(screen.getByText("labels")).toBeInTheDocument();
  });

  it("moves the caret on Home and End", () => {
    const { input } = renderInput();
    type(input, "abc");
    if (!(input instanceof HTMLInputElement)) throw new Error("not input");
    fireEvent.keyDown(input, { key: "Home" });
    expect(input.selectionStart).toBe(0);
    fireEvent.keyDown(input, { key: "End" });
    expect(input.selectionStart).toBe(3);
  });

  it("opens the filter tips popover", () => {
    renderInput();
    fireEvent.click(
      screen.getByRole("button", { name: "button.filterInformation" }),
    );
    expect(screen.getByText("filter.tips.title")).toBeInTheDocument();
    expect(
      screen.getByText('filter.tips.desc.step5 {"exampleTime":"15:00-16:00"}'),
    ).toBeInTheDocument();
  });

  it("shows the 12 hour example time in the tips", () => {
    fixture.is24Hour = false;
    renderInput();
    fireEvent.click(
      screen.getByRole("button", { name: "button.filterInformation" }),
    );
    expect(
      screen.getByText(
        'filter.tips.desc.step5 {"exampleTime":"3:00PM-4:00PM"}',
      ),
    ).toBeInTheDocument();
  });
});

describe("InputWithTags suggestion clicks", () => {
  it("picks a filter type and then a camera value", () => {
    const { props, input } = renderInput();
    type(input, "cam");
    fireEvent.click(screen.getByText("cameras"));
    expect(input).toHaveValue("cameras:");
    expect(
      screen.getByText("filter.header.currentFilterType"),
    ).toBeInTheDocument();
    expect(screen.getByText("camera-name:front_door")).toBeInTheDocument();

    const option = screen.getAllByRole("option")[0];
    if (!option) throw new Error("no camera option");
    fireEvent.click(option);
    expect(props.setFilters).toHaveBeenCalledWith({ cameras: ["front_door"] });
    expect(input).toHaveValue("");
  });

  it("appends a filter type after other words", () => {
    const { input } = renderInput();
    type(input, "dog ");
    fireEvent.click(screen.getByText("zones"));
    // the empty word after the trailing space takes the filter type, so the
    // join does not double the space
    expect(input).toHaveValue("dog zones:");
    expect(screen.getByText("zone-name:yard")).toBeInTheDocument();
  });

  it("converts a time range suggestion to 24 hour values", () => {
    const { props, input } = renderInput();
    type(input, "time_range:");
    fireEvent.click(screen.getByText("15:00-16:00"));
    expect(props.setFilters).toHaveBeenCalledWith({
      time_range: "15:00,16:00",
    });
  });

  it("labels suggestions with translations in other languages", () => {
    fixture.language = "de";
    fixture.config = makeConfig("imperial");
    const { input } = renderInput();
    expect(screen.getByText("cameras (filter.label.cameras)")).toBeTruthy();

    type(input, "labels:");
    expect(screen.getByText("bark (audio:bark)")).toBeInTheDocument();
    expect(screen.getByText("person (object:person)")).toBeInTheDocument();

    type(input, "cameras:");
    expect(screen.getByText("camera-name:back_yard")).toBeInTheDocument();
    type(input, "zones:");
    expect(screen.getByText("zone-name:yard")).toBeInTheDocument();
  });

  it("formats translated value suggestions for other filter types", () => {
    fixture.language = "de";
    const { input } = renderInput();
    type(input, "has_clip:");
    expect(screen.getAllByText(/button\.yes|button\.no/)).toHaveLength(2);
    type(input, "search_type:");
    expect(
      screen.getByText(/filter\.searchType\.thumbnail/),
    ).toBeInTheDocument();
    type(input, "time_range:");
    expect(screen.getByText(/15:00 - 16:00/)).toBeInTheDocument();
  });

  it("falls back to general suggestions for unknown filter types", () => {
    const { input } = renderInput();
    type(input, "color:red");
    expect(screen.getByText("filter.header.noFilters")).toBeInTheDocument();
    expect(screen.queryByText("camera-name:front_door")).toBeNull();
  });

  it.each([
    ["12", { min_speed: 12 }],
    ["-5", {}],
    ["fast", {}],
  ])("only applies a usable picked speed (%j)", (speed, expected) => {
    const { props, input } = renderInput({
      allSuggestions: { ...allSuggestions, min_speed: [speed] },
    });
    type(input, "min_speed:");
    const [option] = screen.getAllByRole("option");
    if (!option) throw new Error("no speed option");
    fireEvent.click(option);
    expect(props.setFilters).toHaveBeenCalledWith(expected);
  });
});

describe("InputWithTags typed filters", () => {
  it.each([
    ["labels:person ", { labels: ["person"] }],
    ["search_type:thumbnail ", { search_type: ["thumbnail"] }],
    ["has_snapshot:yes ", { has_snapshot: 1 }],
    ["has_clip:no ", { has_clip: 0 }],
    ["is_submitted:yes ", { is_submitted: 1 }],
    ["sort:date_asc ", { sort: "date_asc" }],
    ["event_id:abc ", { event_id: "abc" }],
    ["min_score:60 ", { min_score: 0.6 }],
    ["max_score:90,", { max_score: 0.9 }],
    ["min_speed:10 ", { min_speed: 10 }],
    ["max_speed:80 ", { max_speed: 80 }],
    ["time_range:15:00-16:00 ", { time_range: "15:00,16:00" }],
  ])("creates a filter from %j", (text, expected) => {
    const { props, input } = renderInput();
    type(input, text);
    expect(props.setFilters).toHaveBeenCalledWith(expected);
    expect(input).toHaveValue("");
  });

  it("keeps the remaining words after creating a filter", () => {
    const { props, input } = renderInput();
    type(input, "red car labels:person ");
    expect(props.setFilters).toHaveBeenCalledWith({ labels: ["person"] });
    expect(input).toHaveValue("red car");
  });

  it("adds to existing array filters without duplicates", () => {
    const { props, input } = renderInput({
      filters: { labels: ["bark"], search_type: ["thumbnail"] },
    });
    type(input, "labels:person ");
    expect(props.setFilters).toHaveBeenLastCalledWith({
      labels: ["bark", "person"],
      search_type: ["thumbnail"],
    });
  });

  it("parses 12 hour time ranges", () => {
    fixture.is24Hour = false;
    const { props, input } = renderInput();
    type(input, "time_range:3:00PM-4:00PM ");
    expect(props.setFilters).toHaveBeenCalledWith({
      time_range: "15:00,16:00",
    });
  });

  it("creates before and after date filters", () => {
    const { props, input } = renderInput();
    type(input, "after:01022024 ");
    expect(props.setFilters).toHaveBeenCalledWith({
      after: convertLocalDateToTimestamp("01022024") / 1000,
    });
    type(input, "before:01032024 ");
    expect(props.setFilters).toHaveBeenLastCalledWith({
      before: (convertLocalDateToTimestamp("01032024") - 1) / 1000,
    });
  });

  it.each([
    ["labels:cat ", {}],
    ["min_score:20 ", {}],
    ["max_speed:500 ", {}],
    ["after:2024 ", {}],
    ["time_range:25:00-26:00 ", {}],
  ])("ignores the invalid value %j", (text, filters) => {
    const { props, input } = renderInput({ filters });
    type(input, text);
    expect(props.setFilters).not.toHaveBeenCalled();
  });

  it.each([
    [
      "before:01012024 ",
      { after: convertLocalDateToTimestamp("01052024") / 1000 },
      "filter.toast.error.beforeDateBeLaterAfter",
    ],
    [
      "after:01102024 ",
      { before: convertLocalDateToTimestamp("01052024") / 1000 },
      "filter.toast.error.afterDatebeEarlierBefore",
    ],
    [
      "min_score:80 ",
      { max_score: 0.7 },
      "filter.toast.error.minScoreMustBeLessOrEqualMaxScore",
    ],
    [
      "max_score:60 ",
      { min_score: 0.7 },
      "filter.toast.error.maxScoreMustBeGreaterOrEqualMinScore",
    ],
    [
      "min_speed:50 ",
      { max_speed: 20 },
      "filter.toast.error.minSpeedMustBeLessOrEqualMaxSpeed",
    ],
    [
      "max_speed:10 ",
      { min_speed: 20 },
      "filter.toast.error.maxSpeedMustBeGreaterOrEqualMinSpeed",
    ],
  ])("rejects the conflicting %j", (text, filters, message) => {
    const { props, input } = renderInput({ filters });
    type(input, text);
    expect(fixture.toastError).toHaveBeenCalledWith(message, {
      position: "top-center",
    });
    expect(props.setFilters).not.toHaveBeenCalled();
  });
});

describe("InputWithTags active filters", () => {
  it("renders chips for every filter type", () => {
    fixture.config = makeConfig("metric");
    const after = convertLocalDateToTimestamp("01022024") / 1000;
    const before = (convertLocalDateToTimestamp("01032024") - 1) / 1000;
    renderInput({
      filters: {
        cameras: ["front_door"],
        labels: ["bark", "person"],
        zones: ["yard"],
        sub_labels: ["bob_smith"],
        after,
        before,
        time_range: "15:00,16:00",
        min_score: 0.6,
        max_speed: 20,
        has_clip: 1,
        is_submitted: 0,
        search_type: ["thumbnail"],
        event_id: "abc",
        sort: "date_asc",
      },
    });
    const chip = (name: string) =>
      screen.getByRole("button", { name }).parentElement;
    expect(chip("Remove cameras:front door filter")).toHaveTextContent(
      "filter.label.cameras: camera-name:front_door",
    );
    expect(chip("Remove labels:bark filter")).toHaveTextContent(
      "filter.label.labels: audio:bark",
    );
    expect(chip("Remove labels:person filter")).toHaveTextContent(
      "filter.label.labels: object:person",
    );
    expect(chip("Remove zones:yard filter")).toHaveTextContent(
      "zone-name:yard",
    );
    expect(chip("Remove sub_labels:bob smith filter")).toHaveTextContent(
      "filter.label.sub_labels: bob smith",
    );
    expect(chip(`Remove after:${after} filter`)).toHaveTextContent(
      new Date(after * 1000).toLocaleDateString(window.navigator.language),
    );
    expect(chip(`Remove before:${before} filter`)).toHaveTextContent(
      new Date((before + 1) * 1000).toLocaleDateString(
        window.navigator.language,
      ),
    );
    expect(chip("Remove time_range:15:00,16:00 filter")).toHaveTextContent(
      "15:00 - 16:00",
    );
    expect(chip("Remove min_score:0.6 filter")).toHaveTextContent("60%");
    expect(chip("Remove max_speed:20 filter")).toHaveTextContent(
      "20 unit.speed.kph",
    );
    expect(chip("Remove has_clip:1 filter")).toHaveTextContent("button.yes");
    expect(chip("Remove is_submitted:0 filter")).toHaveTextContent(
      "features.submittedToFrigatePlus.label: button.no",
    );
    expect(chip("Remove event_id:abc filter")).toHaveTextContent(
      "trackedObjectId: abc",
    );
    expect(chip("Remove sort:date_asc filter")).toHaveTextContent(
      "filter.label.sort: date asc",
    );
  });

  it("shows 12 hour time ranges and imperial speed units", () => {
    fixture.is24Hour = false;
    renderInput({ filters: { time_range: "15:00,16:00", min_speed: 5 } });
    expect(
      screen.getByRole("button", {
        name: "Remove time_range:15:00,16:00 filter",
      }).parentElement,
    ).toHaveTextContent("3:00 PM - 4:00 PM");
    expect(
      screen.getByRole("button", { name: "Remove min_speed:5 filter" })
        .parentElement,
    ).toHaveTextContent("5 unit.speed.mph");
  });

  it("removes array values and drops empty arrays", () => {
    const { props } = renderInput({
      filters: { labels: ["bark", "person"], cameras: ["front_door"] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove labels:bark filter" }),
    );
    expect(props.setFilters).toHaveBeenLastCalledWith({
      labels: ["person"],
      cameras: ["front_door"],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove cameras:front door filter" }),
    );
    expect(props.setFilters).toHaveBeenLastCalledWith({
      labels: ["bark", "person"],
    });
  });

  it("removes scalar filters and clears is_submitted with has_snapshot", () => {
    const { props } = renderInput({
      filters: {
        before: 100,
        has_snapshot: 1,
        is_submitted: 1,
        sort: "date_desc",
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove before:100 filter" }),
    );
    expect(props.setFilters).toHaveBeenLastCalledWith({
      has_snapshot: 1,
      is_submitted: 1,
      sort: "date_desc",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove has_snapshot:1 filter" }),
    );
    expect(props.setFilters).toHaveBeenLastCalledWith({
      before: 100,
      sort: "date_desc",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove sort:date_desc filter" }),
    );
    expect(props.setFilters).toHaveBeenLastCalledWith({
      before: 100,
      has_snapshot: 1,
      is_submitted: 1,
    });
  });

  it("shows and clears a similarity search", () => {
    const { props, input } = renderInput({
      filters: { search_type: ["similarity"], event_id: "abc" },
      search: "ignored",
    });
    expect(input).toHaveValue("");
    expect(
      screen.getAllByLabelText("similaritySearch.active").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("similaritySearch.title")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove event_id:abc filter" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "similaritySearch.clear" }),
    );
    expect(props.setFilters).toHaveBeenCalledWith({});
  });

  it("clears the search, filters and focus from the clear icon", () => {
    const { container, props, input } = renderInput({
      search: "car",
      filters: { labels: ["person"] },
    });
    expect(input).toHaveValue("car");
    fireEvent.click(tooltipIcon(container, 0));
    expect(props.setInputFocused).toHaveBeenCalledWith(false);
    expect(props.setSearch).toHaveBeenCalledWith("");
    expect(props.setFilters).toHaveBeenCalledWith({});
    expect(input).toHaveValue("");
  });
});

describe("InputWithTags saved searches", () => {
  const saved: SavedSearchQuery = {
    name: "night",
    search: "cars",
    filter: { cameras: ["front_door"] },
  };

  it("saves the current search under a new name", () => {
    fixture.history = [saved];
    const { container } = renderInput({
      search: "dogs",
      filters: { labels: ["bark"] },
    });
    fireEvent.click(tooltipIcon(container, 1));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(
      within(dialog).getByPlaceholderText("search.saveSearch.placeholder"),
      { target: { value: "night" } },
    );
    expect(
      within(dialog).getByText(
        'search.saveSearch.overwrite {"searchName":"night"}',
      ),
    ).toBeInTheDocument();
    fireEvent.change(
      within(dialog).getByPlaceholderText("search.saveSearch.placeholder"),
      { target: { value: " barking " } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "search.saveSearch.button.save.label",
      }),
    );
    expect(fixture.setHistory).toHaveBeenCalledWith([
      saved,
      { name: "barking", search: "dogs", filter: { labels: ["bark"] } },
    ]);
    expect(fixture.toastSuccess).toHaveBeenCalledWith(
      'search.saveSearch.success {"searchName":"barking"}',
      { position: "top-center" },
    );
  });

  it("replaces a saved search with the same name", () => {
    fixture.history = [saved];
    const { container } = renderInput({ search: "trucks" });
    fireEvent.click(tooltipIcon(container, 1));
    fireEvent.change(
      screen.getByPlaceholderText("search.saveSearch.placeholder"),
      { target: { value: "night" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "search.saveSearch.button.save.label",
      }),
    );
    expect(fixture.setHistory).toHaveBeenCalledWith([
      { name: "night", search: "trucks", filter: {} },
    ]);
  });

  it("does not save before persistence has loaded", () => {
    fixture.loaded = false;
    const { container } = renderInput({ search: "trucks" });
    fireEvent.click(tooltipIcon(container, 1));
    fireEvent.change(
      screen.getByPlaceholderText("search.saveSearch.placeholder"),
      { target: { value: "x" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "search.saveSearch.button.save.label",
      }),
    );
    expect(fixture.setHistory).not.toHaveBeenCalled();
  });

  it("loads a saved search and keeps it out of the suggestion list", () => {
    fixture.history = [saved];
    const { props } = renderInput();
    expect(screen.getByText("savedSearches")).toBeInTheDocument();
    expect(screen.getAllByText("night")).toHaveLength(1);
    fireEvent.click(screen.getByText("night"));
    expect(props.setFilters).toHaveBeenCalledWith({ cameras: ["front_door"] });
    expect(props.setSearch).toHaveBeenCalledWith("cars");
  });

  it("deletes a saved search after confirmation", () => {
    fixture.history = [saved, { name: "day", search: "", filter: {} }];
    const { props } = renderInput();
    const item = screen.getByText("night").closest("[cmdk-item]");
    if (!(item instanceof HTMLElement)) throw new Error("no saved item");
    fireEvent.click(within(item).getByRole("button"));
    expect(props.setFilters).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(
      'This will permanently delete the saved search "night".',
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(fixture.setHistory).toHaveBeenCalledWith([
      { name: "day", search: "", filter: {} },
    ]);
    expect(screen.queryByText("night")).toBeNull();
  });
});
