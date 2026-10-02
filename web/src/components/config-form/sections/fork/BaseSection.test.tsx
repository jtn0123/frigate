import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createErrorHandler,
  type FormValidation,
  type RJSFSchema,
} from "@rjsf/utils";
import { StatusBarMessagesContext } from "@/context/statusbar-context";
import type {
  ConfigFormContext,
  ConfigSectionData,
  JsonValue,
} from "@/types/configForm";
import type { SectionRendererProps } from "@/components/config-form/sectionExtras/registry";
import {
  ConfigSection,
  type ConfigSectionProps,
  type SectionConfig,
} from "../BaseSection";

type FormProps = {
  schema?: RJSFSchema;
  formData?: unknown;
  onChange?: (data: unknown) => void;
  onValidationChange?: (hasErrors: boolean) => void;
  hiddenFields?: string[];
  disabled?: boolean;
  customValidate?: (
    formData: unknown,
    errors: FormValidation,
  ) => FormValidation;
  formContext?: ConfigFormContext;
};

type ToastOptions = { action?: ReactNode; duration?: number };

type OverrideState = {
  isOverridden: boolean;
  globalValue: unknown;
  cameraValue: unknown;
};

const h = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  schema: null as RJSFSchema | null,
  override: {
    isOverridden: false,
    globalValue: undefined,
    cameraValue: undefined,
  } as OverrideState,
  formProps: null as FormProps | null,
  exists: false,
  refreshConfig: vi.fn<() => Promise<void>>(),
  swrMutate: vi.fn<(key: string) => Promise<void>>(),
  axiosPut: vi.fn<(url: string, body: unknown) => Promise<unknown>>(),
  toastSuccess: vi.fn<(message: string, options?: ToastOptions) => void>(),
  toastError: vi.fn<(message: string) => void>(),
  sendRestart: vi.fn<(payload: string) => void>(),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key;
  const i18n = { language: "en", exists: () => h.exists };
  return {
    ...(await importOriginal<typeof import("react-i18next")>()),
    useTranslation: () => ({ t, i18n }),
  };
});

vi.mock("swr", () => ({
  default: () => ({ data: h.config, mutate: h.refreshConfig }),
  mutate: (key: string) => h.swrMutate(key),
}));

vi.mock("axios", () => ({
  default: {
    put: (url: string, body: unknown) => h.axiosPut(url, body),
    isAxiosError: (error: unknown) =>
      typeof error === "object" && error !== null && "response" in error,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: (message: string, options?: ToastOptions) =>
      h.toastSuccess(message, options),
    error: (message: string) => h.toastError(message),
  },
}));

vi.mock("@/api/ws", () => ({
  useRestart: () => ({
    payload: "",
    send: (payload: string) => h.sendRestart(payload),
  }),
}));

vi.mock("@/hooks/use-config-schema", () => ({
  useSectionSchema: () => h.schema,
}));

vi.mock("@/hooks/use-config-override", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-config-override")>()),
  useConfigOverride: () => h.override,
}));

vi.mock("@/components/config-form/sectionExtras/registry", () => ({
  default: {},
}));

vi.mock("@/components/config-form/ConfigForm", () => ({
  ConfigForm: (props: FormProps) => {
    h.formProps = props;
    const renderers = props.formContext?.renderers ?? {};
    return (
      <div data-testid="config-form" data-disabled={String(props.disabled)}>
        <span data-testid="form-data">{JSON.stringify(props.formData)}</span>
        {Object.entries(renderers).map(([name, Renderer]) => (
          <Renderer key={name} label={name} />
        ))}
      </div>
    );
  },
}));

vi.mock("@/components/config-form/sections/CameraOverridesBadge", () => ({
  CameraOverridesBadge: ({ sectionPath }: { sectionPath: string }) => (
    <span data-testid="camera-overrides-badge">{sectionPath}</span>
  ),
}));

vi.mock("@/components/config-form/sections/GlobalOverridesBadge", () => ({
  GlobalOverridesBadge: ({ cameraName }: { cameraName: string }) => (
    <span data-testid="global-overrides-badge">{cameraName}</span>
  ),
}));

vi.mock("@/components/config-form/sections/ProfileOverridesBadge", () => ({
  ProfileOverridesBadge: ({
    profileName,
    profileFriendlyName,
  }: {
    profileName: string;
    profileFriendlyName?: string;
  }) => (
    <span data-testid="profile-overrides-badge">
      {profileFriendlyName ?? profileName}
    </span>
  ),
}));

vi.mock("@/components/overlay/detail/SaveAllPreviewPopover", () => ({
  default: ({
    items,
  }: {
    items: Array<{
      fieldPath: string;
      value: unknown;
      scope: string;
      profileName?: string;
    }>;
  }) => (
    <ul data-testid="section-preview">
      {items.map((item) => (
        <li key={item.fieldPath}>
          {`${item.scope}|${item.profileName ?? ""}|${item.fieldPath}=${JSON.stringify(item.value)}`}
        </li>
      ))}
    </ul>
  ),
}));

vi.mock("@/components/overlay/dialog/RestartDialog", () => ({
  default: ({
    isOpen,
    onClose,
    onRestart,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onRestart: () => void;
  }) =>
    isOpen ? (
      <div data-testid="restart-dialog">
        <button type="button" onClick={onRestart}>
          do-restart
        </button>
        <button type="button" onClick={onClose}>
          close-restart
        </button>
      </div>
    ) : null,
}));

const SCHEMA: RJSFSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: false },
    threshold: { type: "number", default: 5 },
  },
};

function baseConfig(): Record<string, unknown> {
  return {
    snapshots: { enabled: true, threshold: 5 },
    genai: {},
    cameras: {
      front: {
        name: "front",
        snapshots: { enabled: false, threshold: 3 },
        profiles: { night: { snapshots: { threshold: 9 } } },
      },
    },
  };
}

const addMessage =
  vi.fn<
    (key: string, message: string, severity?: unknown, id?: string) => string
  >();

function renderSection(props: Partial<ConfigSectionProps> = {}) {
  const defaultConfig: SectionConfig = props.defaultConfig ?? {};
  const element: ReactElement = (
    <MemoryRouter>
      <StatusBarMessagesContext.Provider
        value={{
          messages: {},
          addMessage,
          removeMessage: vi.fn(),
          clearMessages: vi.fn(),
        }}
      >
        <ConfigSection
          sectionPath="snapshots"
          level="global"
          {...props}
          defaultConfig={defaultConfig}
        />
      </StatusBarMessagesContext.Provider>
    </MemoryRouter>
  );
  return render(element);
}

function form(): FormProps {
  if (!h.formProps) {
    throw new Error("ConfigForm was not rendered");
  }
  return h.formProps;
}

function change(data: unknown) {
  act(() => {
    form().onChange?.(data);
  });
}

function button(prefix: string): HTMLElement {
  return screen.getByRole("button", {
    name: (name) => name === prefix || name.startsWith(`${prefix} `),
  });
}

function queryButton(prefix: string): HTMLElement | null {
  return screen.queryByRole("button", {
    name: (name) => name === prefix || name.startsWith(`${prefix} `),
  });
}

function textStarting(prefix: string): HTMLElement {
  return screen.getByText(
    (content) => content === prefix || content.startsWith(`${prefix} `),
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function lastPut(): { url: string; body: unknown } {
  const call = h.axiosPut.mock.calls.at(-1);
  if (!call) {
    throw new Error("axios.put was not called");
  }
  return { url: call[0], body: call[1] };
}

function successMessages(): string[] {
  return h.toastSuccess.mock.calls.map((call) => call[0]);
}

function errorMessages(): string[] {
  return h.toastError.mock.calls.map((call) => call[0]);
}

describe("ConfigSection", () => {
  beforeEach(() => {
    h.config = baseConfig();
    h.schema = SCHEMA;
    h.override = {
      isOverridden: false,
      globalValue: { enabled: true },
      cameraValue: undefined,
    };
    h.formProps = null;
    h.exists = false;
    h.refreshConfig.mockResolvedValue(undefined);
    h.swrMutate.mockResolvedValue(undefined);
    h.axiosPut.mockResolvedValue({ data: { success: true } });
    addMessage.mockReturnValue("id");
  });

  it("renders nothing while the section schema is missing", () => {
    h.schema = null;
    const { container } = renderSection();
    expect(container.innerHTML).toBe("");
  });

  it("shows a loading indicator until the config loads", () => {
    h.config = undefined;
    renderSection();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByTestId("config-form")).toBeNull();
  });

  it("passes the saved global values to the form with Save disabled", () => {
    renderSection();
    expect(screen.getByTestId("form-data")).toHaveTextContent(
      JSON.stringify({ enabled: true, threshold: 5 }),
    );
    expect(form().formContext?.level).toBe("global");
    expect(form().formContext?.sectionI18nPrefix).toBe("snapshots");
    expect(form().formContext?.isProfile).toBe(false);
    expect(button("button.save")).toBeDisabled();
    expect(button("button.resetToDefault")).toBeEnabled();
    // global level hides the title by default
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("shows the title, description and camera overrides badge when asked", () => {
    h.exists = true;
    renderSection({ showTitle: true });
    expect(screen.getByRole("heading")).toHaveTextContent(
      'snapshots.label {"ns":"config/global","defaultValue":"Snapshots"}',
    );
    expect(
      screen.getByText('snapshots.description {"ns":"config/global"}'),
    ).toBeInTheDocument();
    expect(screen.getByTestId("camera-overrides-badge")).toHaveTextContent(
      "snapshots",
    );
  });

  it("ignores the initial onChange that matches the saved values", () => {
    const onStatusChange = vi.fn();
    renderSection({ onStatusChange });
    change({ enabled: true, threshold: 5 });
    expect(screen.queryByText(/^unsavedChanges/)).toBeNull();
    expect(onStatusChange).toHaveBeenLastCalledWith({
      hasChanges: false,
      isOverridden: false,
      overrideSource: undefined,
      hasValidationErrors: false,
    });
  });

  it("tracks an edit as unsaved changes with a field preview", () => {
    const onStatusChange = vi.fn();
    renderSection({ onStatusChange, showTitle: true });
    change({ enabled: false, threshold: 5 });

    expect(textStarting("unsavedChanges")).toBeInTheDocument();
    expect(textStarting("button.modified")).toBeInTheDocument();
    expect(screen.getByTestId("section-preview")).toHaveTextContent(
      "global||snapshots.enabled=false",
    );
    expect(button("button.save")).toBeEnabled();
    expect(queryButton("button.resetToDefault")).toBeNull();
    expect(form().formContext?.overrides).toEqual({ enabled: false });
    expect(onStatusChange).toHaveBeenLastCalledWith({
      hasChanges: true,
      isOverridden: false,
      overrideSource: undefined,
      hasValidationErrors: false,
    });
  });

  it("clears pending data when the form reports a non-object", () => {
    renderSection();
    change({ enabled: false, threshold: 5 });
    expect(textStarting("unsavedChanges")).toBeInTheDocument();
    change(null);
    expect(screen.queryByText(/^unsavedChanges/)).toBeNull();
  });

  it("clears pending data when an edit is reverted to the saved values", () => {
    renderSection();
    change({ enabled: false, threshold: 5 });
    change({ enabled: true, threshold: 5 });
    expect(screen.queryByText(/^unsavedChanges/)).toBeNull();
    expect(button("button.save")).toBeDisabled();
  });

  it("undoes pending changes", () => {
    renderSection();
    change({ enabled: false, threshold: 5 });
    fireEvent.click(button("button.undo"));
    expect(screen.queryByText(/^unsavedChanges/)).toBeNull();
    expect(screen.getByTestId("form-data")).toHaveTextContent(
      JSON.stringify({ enabled: true, threshold: 5 }),
    );
  });

  it("saves a global change that needs a restart and offers the restart", async () => {
    const onSave = vi.fn();
    const onSavingChange = vi.fn();
    renderSection({ onSave, onSavingChange });
    change({ enabled: false, threshold: 5 });

    fireEvent.click(button("button.save"));
    await flush();

    expect(lastPut()).toEqual({
      url: "config/set",
      body: {
        requires_restart: 1,
        update_topic: "config/cameras/*/snapshots",
        config_data: { snapshots: { enabled: false } },
      },
    });
    expect(addMessage).toHaveBeenCalledWith(
      "config_restart_required",
      expect.stringContaining("configForm.restartRequiredFooter"),
      undefined,
      "config_restart_required",
    );
    expect(successMessages()[0]).toContain("toast.successRestartRequired");
    expect(h.refreshConfig).toHaveBeenCalledTimes(1);
    expect(h.swrMutate).toHaveBeenCalledWith("config/raw_paths");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSavingChange.mock.calls).toEqual([[true], [false]]);
    expect(screen.queryByText(/^unsavedChanges/)).toBeNull();

    // the toast action opens the restart dialog
    const options = h.toastSuccess.mock.calls[0]?.[1];
    expect(options?.duration).toBe(10000);
    render(<>{options?.action}</>);
    fireEvent.click(
      screen.getByRole("button", {
        name: 'restart.button {"ns":"components/dialog"}',
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "do-restart" }));
    expect(h.sendRestart).toHaveBeenCalledWith("restart");
    fireEvent.click(screen.getByRole("button", { name: "close-restart" }));
    expect(screen.queryByTestId("restart-dialog")).toBeNull();
  });

  it("saves without a restart when the section lists no restart fields", async () => {
    renderSection({ sectionConfig: { restartRequired: [] } });
    change({ enabled: false, threshold: 5 });
    fireEvent.click(button("button.save"));
    await flush();

    expect(lastPut().body).toEqual({
      requires_restart: 0,
      update_topic: "config/cameras/*/snapshots",
      config_data: { snapshots: { enabled: false } },
    });
    expect(successMessages()[0]).toContain("toast.success ");
    expect(addMessage).not.toHaveBeenCalled();
  });

  it("uses a config/<section> topic for sections that are not camera defaults", async () => {
    h.config = { ...baseConfig(), mqtt: { enabled: true, threshold: 5 } };
    renderSection({ sectionPath: "mqtt", requiresRestart: false });
    change({ enabled: false, threshold: 5 });
    fireEvent.click(button("button.save"));
    await flush();
    expect(lastPut().body).toEqual({
      requires_restart: 0,
      update_topic: "config/mqtt",
      config_data: { mqtt: { enabled: false } },
    });
  });

  it("applies in memory with skipSave", async () => {
    renderSection({ skipSave: true });
    expect(queryButton("button.resetToDefault")).toBeNull();
    change({ enabled: false, threshold: 5 });
    expect(button("button.apply")).toBeEnabled();
    fireEvent.click(button("button.apply"));
    await flush();
    expect(lastPut().body).toEqual({
      requires_restart: 0,
      update_topic: "config/cameras/*/snapshots",
      config_data: { snapshots: { enabled: false } },
      skip_save: true,
    });
    expect(successMessages()[0]).toContain("toast.applied");
  });

  it("shows the saving state while the request is in flight", async () => {
    let resolvePut: (value: unknown) => void = () => {};
    h.axiosPut.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePut = resolve;
        }),
    );
    renderSection();
    change({ enabled: false, threshold: 5 });
    fireEvent.click(button("button.save"));
    await flush();
    expect(textStarting("button.saving")).toBeInTheDocument();
    expect(screen.getByTestId("config-form")).toHaveAttribute(
      "data-disabled",
      "true",
    );
    await act(async () => {
      resolvePut({});
      await Promise.resolve();
    });
    await flush();
    expect(screen.queryByText(/^button\.saving/)).toBeNull();
  });

  it("shows the applying state for skipSave while in flight", async () => {
    h.axiosPut.mockImplementation(() => new Promise(() => {}));
    renderSection({ skipSave: true });
    change({ enabled: false, threshold: 5 });
    fireEvent.click(button("button.apply"));
    await flush();
    expect(textStarting("button.applying")).toBeInTheDocument();
  });

  it("reports Pydantic validation errors from the API", async () => {
    h.axiosPut.mockRejectedValue({
      response: {
        data: {
          detail: [
            { loc: ["body", "snapshots", "enabled"], msg: "bad value" },
            {},
          ],
        },
      },
    });
    const onSave = vi.fn();
    renderSection({ onSave });
    change({ enabled: false, threshold: 5 });
    fireEvent.click(button("button.save"));
    await flush();
    expect(errorMessages()).toEqual([
      `toast.validationError ${JSON.stringify({
        ns: "views/settings",
        defaultValue:
          "Validation failed: snapshots.enabled: bad value, unknown: Invalid value",
      })}`,
    ]);
    expect(onSave).not.toHaveBeenCalled();
    // the edit stays pending
    expect(textStarting("unsavedChanges")).toBeInTheDocument();
  });

  it("reports an API message as is", async () => {
    h.axiosPut.mockRejectedValue({
      response: { data: { message: "Config is read-only" } },
    });
    renderSection();
    change({ enabled: false, threshold: 5 });
    fireEvent.click(button("button.save"));
    await flush();
    expect(errorMessages()).toEqual(["Config is read-only"]);
  });

  it("falls back to a generic error for other API responses", async () => {
    h.axiosPut.mockRejectedValue({ response: { data: { other: true } } });
    renderSection();
    change({ enabled: false, threshold: 5 });
    fireEvent.click(button("button.save"));
    await flush();
    expect(errorMessages()[0]).toMatch(/^toast\.error /);
  });

  it("falls back to a generic error for non-axios failures", async () => {
    h.axiosPut.mockRejectedValue(new Error("network"));
    renderSection();
    change({ enabled: false, threshold: 5 });
    fireEvent.click(button("button.save"));
    await flush();
    expect(errorMessages()[0]).toMatch(/^toast\.error /);
  });

  it("disables Save while the form has validation errors or Save All runs", () => {
    const { rerender } = renderSection();
    change({ enabled: false, threshold: 5 });
    expect(button("button.save")).toBeEnabled();
    act(() => {
      form().onValidationChange?.(true);
    });
    expect(button("button.save")).toBeDisabled();
    act(() => {
      form().onValidationChange?.(false);
    });
    rerender(
      <MemoryRouter>
        <StatusBarMessagesContext.Provider
          value={{
            messages: {},
            addMessage,
            removeMessage: vi.fn(),
            clearMessages: vi.fn(),
          }}
        >
          <ConfigSection
            sectionPath="snapshots"
            level="global"
            defaultConfig={{}}
            isSavingAll
          />
        </StatusBarMessagesContext.Provider>
      </MemoryRouter>,
    );
    expect(button("button.save")).toBeDisabled();
    expect(button("button.undo")).toBeDisabled();
  });

  it("resets a global section to defaults after confirmation", async () => {
    renderSection();
    fireEvent.click(button("button.resetToDefault"));
    expect(
      screen.getByText('confirmReset {"ns":"views/settings"}'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('resetToDefaultDescription {"ns":"views/settings"}'),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: 'button.resetToDefault {"ns":"common"}',
      }),
    );
    await flush();
    await flush();
    expect(lastPut().body).toEqual({
      requires_restart: 1,
      update_topic: "config/cameras/*/snapshots",
      config_data: { snapshots: "" },
    });
    expect(successMessages()[0]).toContain(
      '"defaultValue":"Reset to defaults"',
    );
    expect(h.refreshConfig).toHaveBeenCalled();
    expect(screen.queryByText(/^confirmReset/)).toBeNull();
  });

  it("reports a failed reset", async () => {
    h.axiosPut.mockRejectedValue(new Error("nope"));
    renderSection();
    fireEvent.click(button("button.resetToDefault"));
    fireEvent.click(
      screen.getByRole("button", {
        name: 'button.resetToDefault {"ns":"common"}',
      }),
    );
    await flush();
    await flush();
    expect(errorMessages()[0]).toMatch(/^toast\.resetError /);
  });

  it("edits camera values and saves them under the camera path", async () => {
    h.override = {
      isOverridden: true,
      globalValue: { enabled: true },
      cameraValue: { enabled: false },
    };
    const onStatusChange = vi.fn();
    renderSection({ level: "camera", cameraName: "front", onStatusChange });

    expect(screen.getByRole("heading")).toHaveTextContent(/^snapshots\.label/);
    expect(screen.getByTestId("global-overrides-badge")).toHaveTextContent(
      "front",
    );
    expect(screen.getByTestId("form-data")).toHaveTextContent(
      JSON.stringify({ enabled: false, threshold: 3 }),
    );
    expect(form().formContext?.fullCameraConfig).toEqual(
      expect.objectContaining({ name: "front" }),
    );
    expect(onStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ isOverridden: true, overrideSource: "global" }),
    );
    expect(button("button.resetToGlobal")).toBeEnabled();

    change({ enabled: true, threshold: 3 });
    fireEvent.click(button("button.save"));
    await flush();
    expect(lastPut().body).toEqual({
      requires_restart: 1,
      update_topic: "config/cameras/front/snapshots",
      config_data: { cameras: { front: { snapshots: { enabled: true } } } },
    });
  });

  it("resets a camera override to global after confirmation", async () => {
    h.override = {
      isOverridden: true,
      globalValue: undefined,
      cameraValue: undefined,
    };
    renderSection({ level: "camera", cameraName: "front" });
    fireEvent.click(button("button.resetToGlobal"));
    expect(
      screen.getByText('resetToGlobalDescription {"ns":"views/settings"}'),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: 'button.resetToGlobal {"ns":"common"}',
      }),
    );
    await flush();
    await flush();
    expect(lastPut().body).toEqual({
      requires_restart: 1,
      update_topic: "config/cameras/front/snapshots",
      config_data: { cameras: { front: { snapshots: "" } } },
    });
    expect(successMessages()[0]).toContain("Reset to global defaults");
  });

  it("hides the reset button for a camera without an override", () => {
    renderSection({ level: "camera", cameraName: "front" });
    expect(queryButton("button.resetToGlobal")).toBeNull();
    expect(screen.queryByTestId("global-overrides-badge")).toBeNull();
  });

  it("treats replay like a camera section", () => {
    renderSection({
      level: "replay",
      cameraName: "front",
      collapsible: true,
      defaultCollapsed: false,
    });
    expect(form().formContext?.level).toBe("camera");
    expect(screen.getByRole("heading")).toHaveClass("text-base");
  });

  it("edits a profile on top of the base camera values", async () => {
    const onStatusChange = vi.fn();
    renderSection({
      level: "camera",
      cameraName: "front",
      profileName: "night",
      profileFriendlyName: "Night",
      sectionConfig: { restartRequired: ["enabled"], hiddenFields: ["x"] },
      onStatusChange,
    });

    // restart-only fields are hidden (and stripped) while editing a profile
    expect(screen.getByTestId("form-data")).toHaveTextContent(
      JSON.stringify({ threshold: 9 }),
    );
    expect(screen.getByTestId("profile-overrides-badge")).toHaveTextContent(
      "Night",
    );
    expect(form().hiddenFields).toEqual(["x", "enabled"]);
    expect(form().formContext?.isProfile).toBe(true);
    expect(onStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isOverridden: true,
        overrideSource: "profile",
      }),
    );
    // profiles cannot be reset to global
    expect(queryButton("button.resetToGlobal")).toBeNull();

    change({ enabled: false, threshold: 11 });
    expect(screen.getByTestId("section-preview")).toHaveTextContent(
      "camera|Night|snapshots.threshold=11",
    );
    fireEvent.click(button("button.save"));
    await flush();
    expect(lastPut().body).toEqual({
      requires_restart: 0,
      update_topic: undefined,
      config_data: {
        cameras: {
          front: { profiles: { night: { snapshots: { threshold: 11 } } } },
        },
      },
    });
  });

  it("uses the base value for a profile without overrides", () => {
    renderSection({
      level: "camera",
      cameraName: "front",
      profileName: "day",
    });
    expect(screen.getByTestId("form-data")).toHaveTextContent(
      JSON.stringify({ enabled: false, threshold: 3 }),
    );
    expect(screen.queryByTestId("profile-overrides-badge")).toBeNull();
  });

  it("removes a profile override after confirmation", () => {
    const onDeleteProfileSection = vi.fn();
    renderSection({
      level: "camera",
      cameraName: "front",
      profileName: "night",
      onDeleteProfileSection,
    });
    fireEvent.click(button("profiles.removeOverride"));
    expect(
      screen.getByText(
        `profiles.deleteSectionConfirm ${JSON.stringify({
          ns: "views/settings",
          profile: "night",
          section: `snapshots.label ${JSON.stringify({
            ns: "config/cameras",
            defaultValue: "snapshots",
          })}`,
          camera: "front",
        })}`,
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: 'button.delete {"ns":"common"}' }),
    );
    expect(onDeleteProfileSection).toHaveBeenCalledTimes(1);
  });

  it("reports edits to a parent that owns pending data", () => {
    const onPendingDataChange = vi.fn();
    renderSection({ pendingDataBySection: {}, onPendingDataChange });
    change({ enabled: false, threshold: 5 });
    expect(onPendingDataChange).toHaveBeenLastCalledWith(
      "snapshots",
      undefined,
      { enabled: false, threshold: 5 },
    );
  });

  it("reads pending data from the parent by camera key", () => {
    const pending: Record<string, ConfigSectionData> = {
      "front::snapshots": { enabled: true, threshold: 3 },
    };
    renderSection({
      level: "camera",
      cameraName: "front",
      pendingDataBySection: pending,
      onPendingDataChange: vi.fn(),
    });
    expect(screen.getByTestId("form-data")).toHaveTextContent(
      JSON.stringify({ enabled: true, threshold: 3 }),
    );
    expect(textStarting("unsavedChanges")).toBeInTheDocument();
    expect(screen.getByTestId("section-preview")).toHaveTextContent(
      "camera||snapshots.enabled=true",
    );
  });

  it("hides the action bar when embedded", () => {
    renderSection({ embedded: true });
    expect(queryButton("button.save")).toBeNull();
  });

  it("hides the action bar for an empty map section with an empty state", () => {
    h.schema = { type: "object", additionalProperties: { type: "object" } };
    renderSection({
      sectionPath: "genai",
      sectionConfig: {
        uiSchema: { "ui:options": { forkEmptyState: "genaiProviders" } },
      },
    });
    expect(queryButton("button.save")).toBeNull();
    expect(queryButton("button.resetToDefault")).toBeNull();
  });

  it("collapses the section behind its title", () => {
    h.override = {
      isOverridden: true,
      globalValue: undefined,
      cameraValue: undefined,
    };
    renderSection({
      level: "camera",
      cameraName: "front",
      collapsible: true,
    });
    expect(screen.getByTestId("global-overrides-badge")).toBeInTheDocument();
    expect(screen.queryByTestId("config-form")).toBeNull();
    fireEvent.click(screen.getByRole("heading"));
    expect(screen.getByTestId("config-form")).toBeInTheDocument();
    change({ enabled: true, threshold: 3 });
    expect(textStarting("button.modified")).toBeInTheDocument();
  });

  it("shows the profile and camera badges in collapsible mode", () => {
    renderSection({
      level: "camera",
      cameraName: "front",
      profileName: "night",
      collapsible: true,
      defaultCollapsed: false,
    });
    expect(screen.getByTestId("profile-overrides-badge")).toHaveTextContent(
      "night",
    );
    expect(screen.getByTestId("config-form")).toBeInTheDocument();
  });

  it("shows the camera overrides badge on a collapsible global section", () => {
    renderSection({ collapsible: true });
    expect(screen.getByTestId("camera-overrides-badge")).toBeInTheDocument();
  });

  it("chains the custom and built-in validators", () => {
    const custom = vi.fn((_data: unknown, errors: FormValidation) => errors);
    h.config = {
      ...baseConfig(),
      detect: { enabled: true, threshold: 5 },
    };
    renderSection({
      sectionPath: "detect",
      sectionConfig: { customValidate: custom },
    });
    const errors = createErrorHandler<unknown>({ enabled: true });
    const validate = form().customValidate;
    expect(validate).toBeDefined();
    const result = validate?.({ enabled: true }, errors);
    expect(custom).toHaveBeenCalledWith({ enabled: true }, errors);
    expect(result).toBe(errors);
  });

  it("passes no validator when none applies", () => {
    renderSection();
    expect(form().customValidate).toBeUndefined();
  });

  it("renders section renderers with runtime props", () => {
    const seen: SectionRendererProps[] = [];
    const Renderer = (props: SectionRendererProps) => {
      seen.push(props);
      return <span data-testid="renderer">{String(props["label"])}</span>;
    };
    renderSection({
      level: "camera",
      cameraName: "front",
      sectionConfig: { renderers: { Extra: Renderer } },
    });
    expect(screen.getByTestId("renderer")).toHaveTextContent("Extra");
    expect(seen.at(-1)?.selectedCamera).toBe("front");

    change({ enabled: true, threshold: 3 });
    expect(textStarting("unsavedChanges")).toBeInTheDocument();

    // signalling changes without pending data is a no-op
    act(() => {
      seen.at(-1)?.setUnsavedChanges?.(true);
    });
    expect(textStarting("unsavedChanges")).toBeInTheDocument();

    // signalling no changes clears pending data
    act(() => {
      seen.at(-1)?.setUnsavedChanges?.(false);
    });
    expect(screen.queryByText(/^unsavedChanges/)).toBeNull();
  });

  it("marks extra changes from the form context as unsaved", () => {
    renderSection();
    act(() => {
      form().formContext?.setExtraHasChanges?.(true);
    });
    expect(textStarting("unsavedChanges")).toBeInTheDocument();
    // nothing to preview without pending overrides
    expect(screen.getByTestId("section-preview")).toBeEmptyDOMElement();
    fireEvent.click(button("button.undo"));
    expect(screen.queryByText(/^unsavedChanges/)).toBeNull();
  });

  it("forwards onFormDataChange edits through the change handler", () => {
    renderSection();
    act(() => {
      form().formContext?.onFormDataChange?.({ enabled: false, threshold: 5 });
    });
    expect(textStarting("unsavedChanges")).toBeInTheDocument();
  });

  it("shows a conditional message banner that matches the form data", () => {
    renderSection({
      sectionConfig: {
        messages: [
          {
            key: "m1",
            messageKey: "messages.snapshotsOn",
            severity: "warning",
            condition: (ctx) => ctx.formData["enabled"] === true,
          },
        ],
      },
    });
    expect(screen.getByText(/messages\.snapshotsOn/)).toBeInTheDocument();
  });

  it("exposes the baseline values to field templates", () => {
    renderSection();
    change({ enabled: false, threshold: 5 });
    const baseline: JsonValue | undefined =
      form().formContext?.baselineFormData;
    expect(baseline).toEqual({ enabled: true, threshold: 5 });
  });
});
