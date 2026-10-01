import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileState } from "@/types/profile";
import ProfilesView from "../ProfilesView";

const state = vi.hoisted(() => ({
  config: undefined as unknown,
  profiles: undefined as unknown,
  updateConfig: vi.fn<() => Promise<unknown>>(),
  updateProfiles: vi.fn<() => Promise<unknown>>(),
  put: vi.fn<(url: string, body?: unknown) => Promise<unknown>>(),
  toastSuccess: vi.fn<(message: string, options?: unknown) => void>(),
  toastError: vi.fn<(message: string, options?: unknown) => void>(),
}));

/** Narrows an indexed lookup that the test knows is present. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

vi.mock("swr", () => ({
  default: (key: string) => {
    if (key === "config") {
      return { data: state.config, mutate: state.updateConfig };
    }
    if (key === "profiles") {
      return { data: state.profiles, mutate: state.updateProfiles };
    }
    return { data: undefined };
  },
}));
vi.mock("axios", () => ({
  default: {
    put: (url: string, body?: unknown) => state.put(url, body),
    isAxiosError: (error: unknown) =>
      typeof error === "object" && error !== null && "response" in error,
  },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (message: string, options?: unknown) =>
      state.toastSuccess(message, options),
    error: (message: string, options?: unknown) =>
      state.toastError(message, options),
  },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) => {
      const rest = { ...options };
      delete rest["ns"];
      delete rest["defaultValue"];
      return Object.keys(rest).length > 0
        ? `${key} ${JSON.stringify(rest)}`
        : key;
    },
  }),
}));
// Radix Select needs pointer and layout APIs jsdom lacks; this stand-in keeps
// the value and change contract with plain buttons.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  type Ctx = {
    value?: string | undefined;
    onValueChange?: ((value: string) => void) | undefined;
  };
  const SelectContext = React.createContext<Ctx>({});
  return {
    Select: (props: {
      value?: string;
      disabled?: boolean;
      onValueChange?: (value: string) => void;
      children?: React.ReactNode;
    }) => (
      <SelectContext.Provider
        value={{ value: props.value, onValueChange: props.onValueChange }}
      >
        <div
          data-testid="profile-select"
          data-value={props.value}
          data-disabled={String(props.disabled ?? false)}
        >
          {props.children}
        </div>
      </SelectContext.Provider>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: (props: { children?: React.ReactNode }) => (
      <div role="listbox">{props.children}</div>
    ),
    SelectItem: (props: { value: string; children?: React.ReactNode }) => {
      const ctx = React.useContext(SelectContext);
      return (
        <button
          role="option"
          aria-selected={ctx.value === props.value}
          onClick={() => ctx.onValueChange?.(props.value)}
        >
          {props.children}
        </button>
      );
    },
  };
});

function makeConfig() {
  return {
    cameras: {
      front_door: {
        friendly_name: "Front Door",
        ui: { order: 2 },
        profiles: {
          night: { detect: { enabled: true }, review: null, enabled: false },
        },
      },
      back_yard: {
        ui: { order: 1 },
        profiles: { night: { record: { enabled: true } } },
      },
      garage: {
        ui: { order: 3 },
        profiles: { night: { enabled: null } },
      },
      _replay_front: {
        ui: { order: 0 },
        profiles: { night: { detect: { enabled: true } } },
      },
      porch: { ui: { order: 4 } },
    },
  };
}

function makeProfileState(names: string[]): ProfileState {
  return {
    editingProfile: {},
    allProfileNames: names,
    profileFriendlyNames: new Map([["night", "Night Mode"]]),
    onSelectProfile: vi.fn(),
    onDeleteProfileSection: vi.fn(),
  };
}

function renderView(
  props: Parameters<typeof ProfilesView>[0] = {
    profileState: makeProfileState(["night", "away"]),
  },
) {
  return render(
    <MemoryRouter>
      <ProfilesView {...props} />
    </MemoryRouter>,
  );
}

function rowButtons(label: string): HTMLElement[] {
  const header = screen
    .getByText(label, { selector: "span.truncate" })
    .closest("[aria-expanded]");
  if (!(header instanceof HTMLElement)) {
    throw new Error(`no profile header for ${label}`);
  }
  return within(header).getAllByRole("button");
}

function httpError(message?: string) {
  return { response: { data: message ? { message } : {} } };
}

beforeEach(() => {
  state.config = makeConfig();
  state.profiles = {
    profiles: [],
    active_profile: "night",
    last_activated: {},
  };
  state.updateConfig.mockResolvedValue(undefined);
  state.updateProfiles.mockResolvedValue(undefined);
  state.put.mockResolvedValue({ status: 200 });
});

describe("ProfilesView without profiles", () => {
  it("renders nothing until config and profiles load", () => {
    state.profiles = undefined;
    const { container } = renderView();
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the enable switch and the how-it-works steps", () => {
    const setProfilesUIEnabled = vi.fn();
    renderView({
      profileState: makeProfileState([]),
      profilesUIEnabled: false,
      setProfilesUIEnabled,
    });

    expect(document.title).toBe("documentTitle.profiles");
    expect(screen.getByText("profiles.title")).toBeInTheDocument();
    expect(screen.getByTestId("profiles-how-it-works")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://docs.frigate.video/configuration/profiles",
    );
    expect(screen.queryByText("profiles.addProfile")).toBeNull();
    expect(screen.queryByText("profiles.noProfiles")).toBeNull();

    const toggle = screen.getByRole("switch");
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(setProfilesUIEnabled).toHaveBeenCalledWith(true);
  });

  it("hides the switch when the toggle setter is missing", () => {
    renderView({});
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows the enabled hint, empty list and add button once enabled", () => {
    renderView({
      profileState: makeProfileState([]),
      profilesUIEnabled: true,
      setProfilesUIEnabled: vi.fn(),
    });

    expect(screen.getByRole("switch")).toBeChecked();
    expect(screen.getByText("profiles.enabledDescription")).toBeInTheDocument();
    expect(screen.getByText("profiles.noProfiles")).toBeInTheDocument();
    expect(screen.getByText("profiles.addProfile")).toBeInTheDocument();
    expect(screen.queryByTestId("profile-select")).toBeNull();
  });
});

describe("ProfilesView profile list", () => {
  it("lists profiles with the active badge and override counts", () => {
    renderView();

    expect(screen.queryByTestId("profiles-how-it-works")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByTestId("profile-select")).toHaveAttribute(
      "data-value",
      "night",
    );
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "profiles.noActiveProfile",
      "Night Mode",
      "away",
    ]);
    expect(screen.getByText("profiles.active")).toBeInTheDocument();
    // the replay camera and the camera with only null overrides are skipped
    expect(
      screen.getByText('profiles.cameraCount {"count":2}'),
    ).toBeInTheDocument();
    expect(screen.getByText("profiles.noOverrides")).toBeInTheDocument();
  });

  it("uses the none option when no profile is active", () => {
    state.profiles = { profiles: [], active_profile: null, last_activated: {} };
    renderView();

    expect(screen.getByTestId("profile-select")).toHaveAttribute(
      "data-value",
      "__none__",
    );
    expect(screen.queryByText("profiles.active")).toBeNull();
  });

  it("expands a profile to show cameras in order with their sections", () => {
    renderView();

    const header = screen
      .getByText("Night Mode", { selector: "span.truncate" })
      .closest("[aria-expanded]");
    if (!(header instanceof HTMLElement)) throw new Error("no header");
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByText("profiles.columnCamera")).toBeInTheDocument();
    const names = screen
      .getAllByText(/^(back yard|Front Door)$/)
      .map((el) => el.textContent);
    expect(names).toEqual(["back yard", "Front Door"]);
    expect(screen.getByText("configForm.sections.record")).toBeInTheDocument();
    expect(
      screen.getByText(
        "configForm.sections.detect, configForm.sections.enabled",
      ),
    ).toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("shows no overrides when an empty profile is expanded", () => {
    renderView();

    const header = screen
      .getByText("away", { selector: "span.truncate" })
      .closest("[aria-expanded]");
    if (!(header instanceof HTMLElement)) throw new Error("no header");
    fireEvent.click(header);
    expect(screen.getAllByText("profiles.noOverrides")).toHaveLength(2);
  });

  it("shows no overrides for every profile when config has no cameras with data", () => {
    state.config = { cameras: {} };
    renderView();
    expect(screen.getAllByText("profiles.noOverrides")).toHaveLength(2);
  });
});

describe("ProfilesView activation", () => {
  it("activates a profile by its friendly name", async () => {
    renderView();

    fireEvent.click(screen.getByRole("option", { name: "away" }));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'profiles.activated {"profile":"away"}',
        { position: "top-center" },
      ),
    );
    expect(state.put).toHaveBeenCalledWith("camera/*/set/profile", {
      value: "away",
    });
    expect(state.updateProfiles).toHaveBeenCalledTimes(1);
  });

  it("uses the friendly name in the activation toast", async () => {
    state.profiles = { profiles: [], active_profile: null, last_activated: {} };
    renderView();

    fireEvent.click(screen.getByRole("option", { name: "Night Mode" }));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'profiles.activated {"profile":"Night Mode"}',
        { position: "top-center" },
      ),
    );
  });

  it("deactivates with the none option", async () => {
    renderView();

    fireEvent.click(
      screen.getByRole("option", { name: "profiles.noActiveProfile" }),
    );

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith("profiles.deactivated", {
        position: "top-center",
      }),
    );
    expect(state.put).toHaveBeenCalledWith("camera/*/set/profile", {
      value: "none",
    });
  });

  it("disables the select while the request is pending", async () => {
    let resolvePut: (value: unknown) => void = () => undefined;
    state.put.mockReturnValue(
      new Promise((resolve) => {
        resolvePut = resolve;
      }),
    );
    renderView();

    fireEvent.click(screen.getByRole("option", { name: "away" }));
    await waitFor(() =>
      expect(screen.getByTestId("profile-select")).toHaveAttribute(
        "data-disabled",
        "true",
      ),
    );
    resolvePut({ status: 200 });
    await waitFor(() =>
      expect(screen.getByTestId("profile-select")).toHaveAttribute(
        "data-disabled",
        "false",
      ),
    );
  });

  it.each([
    [httpError("camera offline"), "camera offline"],
    [httpError(), "profiles.activateFailed"],
    [new Error("boom"), "profiles.activateFailed"],
  ])("toasts activation failures", async (error, message) => {
    state.put.mockRejectedValue(error);
    renderView();

    fireEvent.click(screen.getByRole("option", { name: "away" }));

    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(message, {
        position: "top-center",
      }),
    );
    expect(state.updateProfiles).not.toHaveBeenCalled();
  });
});

describe("ProfilesView delete", () => {
  it("deactivates and removes the active profile from config and cameras", async () => {
    renderView();

    const [, deleteButton] = rowButtons("Night Mode");
    fireEvent.click(must(deleteButton));
    // the click does not toggle the collapsible
    expect(screen.queryByText("profiles.columnCamera")).toBeNull();

    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(
        'profiles.deleteProfileConfirm {"profile":"Night Mode"}',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText("button.delete"));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'profiles.deleteSuccess {"profile":"Night Mode"}',
        { position: "top-center" },
      ),
    );
    expect(state.put).toHaveBeenNthCalledWith(1, "camera/*/set/profile", {
      value: "none",
    });
    expect(state.put).toHaveBeenNthCalledWith(2, "config/set", {
      requires_restart: 0,
      config_data: {
        profiles: { night: "" },
        cameras: {
          front_door: { profiles: { night: "" } },
          back_yard: { profiles: { night: "" } },
          garage: { profiles: { night: "" } },
          _replay_front: { profiles: { night: "" } },
        },
      },
    });
    expect(state.updateConfig).toHaveBeenCalledTimes(1);
    expect(state.updateProfiles).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("removes an inactive profile without camera data in one request", async () => {
    renderView();

    const [, deleteButton] = rowButtons("away");
    fireEvent.click(must(deleteButton));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByText("button.delete"),
    );

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'profiles.deleteSuccess {"profile":"away"}',
        { position: "top-center" },
      ),
    );
    expect(state.put).toHaveBeenCalledTimes(1);
    expect(state.put).toHaveBeenCalledWith("config/set", {
      requires_restart: 0,
      config_data: { profiles: { away: "" } },
    });
  });

  it.each([
    [httpError("config locked"), "config locked"],
    [new Error("boom"), "toast.save.error.noMessage"],
  ])("toasts delete failures and closes the dialog", async (error, message) => {
    state.put.mockRejectedValue(error);
    renderView();

    const [, deleteButton] = rowButtons("away");
    fireEvent.click(must(deleteButton));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByText("button.delete"),
    );

    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(message, {
        position: "top-center",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(state.updateConfig).not.toHaveBeenCalled();
  });

  it("cancels the delete confirmation", async () => {
    renderView();

    const [, deleteButton] = rowButtons("away");
    fireEvent.click(must(deleteButton));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByText("button.cancel"),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(state.put).not.toHaveBeenCalled();
  });
});

describe("ProfilesView rename", () => {
  it("renames a profile with the trimmed friendly name", async () => {
    renderView();

    const [renameButton] = rowButtons("Night Mode");
    fireEvent.click(must(renameButton));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("profiles.renameProfile")).toBeVisible();
    const input = within(dialog).getByRole("textbox");
    expect(input).toHaveValue("Night Mode");

    fireEvent.change(input, { target: { value: "   " } });
    expect(within(dialog).getByText("button.save")).toBeDisabled();

    fireEvent.change(input, { target: { value: "  Evening  " } });
    fireEvent.click(within(dialog).getByText("button.save"));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'profiles.renameSuccess {"profile":"Evening"}',
        { position: "top-center" },
      ),
    );
    expect(state.put).toHaveBeenCalledWith("config/set", {
      requires_restart: 0,
      config_data: { profiles: { night: { friendly_name: "Evening" } } },
    });
    expect(state.updateConfig).toHaveBeenCalledTimes(1);
    expect(state.updateProfiles).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("prefills the id when the profile has no friendly name and closes on Escape", async () => {
    renderView();

    const [renameButton] = rowButtons("away");
    fireEvent.click(must(renameButton));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("textbox")).toHaveValue("away");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("toasts a failed rename", async () => {
    state.put.mockRejectedValue(new Error("boom"));
    renderView();

    const [renameButton] = rowButtons("away");
    fireEvent.click(must(renameButton));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByText("button.save"),
    );

    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(
        "toast.save.error.noMessage",
        { position: "top-center" },
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes the rename dialog on cancel", async () => {
    renderView();

    const [renameButton] = rowButtons("away");
    fireEvent.click(must(renameButton));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByText("button.cancel"),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.put).not.toHaveBeenCalled();
  });
});

describe("ProfilesView add", () => {
  function openAddDialog(): HTMLElement {
    fireEvent.click(screen.getByText("profiles.addProfile"));
    return screen.getByRole("dialog");
  }

  it("creates a profile with an id derived from the friendly name", async () => {
    renderView();

    const dialog = openAddDialog();
    expect(within(dialog).getByText("profiles.newProfile")).toBeVisible();
    const submit = within(dialog).getByText("button.add");
    expect(submit).toBeDisabled();

    fireEvent.change(
      within(dialog).getByPlaceholderText("profiles.profileNamePlaceholder"),
      { target: { value: "Day Shift" } },
    );
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'profiles.createSuccess {"profile":"Day Shift"}',
        { position: "top-center" },
      ),
    );
    expect(state.put).toHaveBeenCalledWith("config/set", {
      requires_restart: 0,
      config_data: { profiles: { day_shift: { friendly_name: "Day Shift" } } },
    });
    expect(state.updateConfig).toHaveBeenCalledTimes(1);
    expect(state.updateProfiles).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("rejects an id that already exists", async () => {
    renderView();

    const dialog = openAddDialog();
    fireEvent.change(
      within(dialog).getByPlaceholderText("profiles.profileNamePlaceholder"),
      { target: { value: "Night" } },
    );

    expect(
      await within(dialog).findByText("profiles.error.alreadyExists"),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText("button.add"));
    await waitFor(() =>
      expect(within(dialog).getByText("button.add")).toBeEnabled(),
    );
    expect(state.put).not.toHaveBeenCalled();
  });

  it("validates the id for length and periods", async () => {
    renderView();

    const dialog = openAddDialog();
    fireEvent.change(
      within(dialog).getByPlaceholderText("profiles.profileNamePlaceholder"),
      { target: { value: "Late" } },
    );
    fireEvent.click(
      within(dialog).getByText('label.show {"item":"profiles.profileIdLabel"}'),
    );
    expect(
      within(dialog).getByText("profiles.profileIdDescription"),
    ).toBeInTheDocument();
    const idInput = await within(dialog).findByDisplayValue("late");

    fireEvent.change(idInput, { target: { value: "a.b" } });
    fireEvent.click(within(dialog).getByText("button.add"));
    expect(
      await within(dialog).findByText("profiles.error.mustNotContainPeriod"),
    ).toBeInTheDocument();

    fireEvent.change(idInput, { target: { value: "x" } });
    fireEvent.click(within(dialog).getByText("button.add"));
    expect(
      await within(dialog).findByText(
        "profiles.error.mustBeAtLeastTwoCharacters",
      ),
    ).toBeInTheDocument();
    expect(state.put).not.toHaveBeenCalled();
  });

  it("toasts a failed create and keeps the dialog open", async () => {
    state.put.mockRejectedValue(new Error("boom"));
    renderView();

    const dialog = openAddDialog();
    fireEvent.change(
      within(dialog).getByPlaceholderText("profiles.profileNamePlaceholder"),
      { target: { value: "Day Shift" } },
    );
    const submit = within(dialog).getByText("button.add");
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(
        "toast.save.error.noMessage",
        { position: "top-center" },
      ),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("resets the form when the dialog is closed", async () => {
    renderView();

    let dialog = openAddDialog();
    fireEvent.change(
      within(dialog).getByPlaceholderText("profiles.profileNamePlaceholder"),
      { target: { value: "Day Shift" } },
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = openAddDialog();
    expect(
      within(dialog).getByPlaceholderText("profiles.profileNamePlaceholder"),
    ).toHaveValue("");

    fireEvent.click(within(dialog).getByText("button.cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
