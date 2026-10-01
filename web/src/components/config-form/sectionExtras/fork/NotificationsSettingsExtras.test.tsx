import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBarMessagesContext } from "@/context/statusbar-context";
import type { ConfigFormContext, ConfigSectionData } from "@/types/configForm";
import NotificationsSettingsExtras, {
  CameraNotificationSwitch,
} from "../NotificationsSettingsExtras";
import { ConfigSection } from "@/components/config-form/sections/BaseSection";
import notificationsSection from "@/components/config-form/section-configs/notifications";

type CameraFixture = {
  name: string;
  enabled_in_config: boolean;
  ui: { order: number };
  notifications?: {
    enabled: boolean;
    enabled_in_config: boolean;
    email?: string;
  };
};

type ConfigFixture = {
  notifications: { enabled: boolean; email?: string };
  cameras: Record<string, CameraFixture>;
  ui: { timezone?: string };
};

const h = vi.hoisted(() => ({
  swr: {} as Record<string, unknown>,
  swrError: {} as Record<string, unknown>,
  isAdmin: true,
  isIOS: false,
  isPWA: false,
  notificationState: {} as Record<string, string>,
  suspendState: {} as Record<string, string>,
  sendNotification: vi.fn<(camera: string, payload: string) => void>(),
  sendSuspend: vi.fn<(camera: string, payload: number) => void>(),
  sendTest: vi.fn<(payload: string) => void>(),
  axiosPost: vi.fn<(url: string, body: unknown) => Promise<unknown>>(),
  toastSuccess: vi.fn<(message: string) => void>(),
  toastError: vi.fn<(message: string) => void>(),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key;
  return {
    ...(await importOriginal<typeof import("react-i18next")>()),
    useTranslation: () => ({
      t,
      i18n: { language: "en", exists: () => false },
    }),
    Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  };
});

vi.mock("swr", () => ({
  default: (key: string | null) => ({
    data: key === null ? undefined : h.swr[key],
    error: key === null ? undefined : h.swrError[key],
  }),
}));

vi.mock("axios", () => ({
  default: {
    post: (url: string, body: unknown) => h.axiosPost(url, body),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: (message: string) => h.toastSuccess(message),
    error: (message: string) => h.toastError(message),
  },
}));

vi.mock("@/api/ws", () => ({
  useNotifications: (camera: string) => ({
    payload: h.notificationState[camera] ?? "ON",
    send: (payload: string) => h.sendNotification(camera, payload),
  }),
  useNotificationSuspend: (camera: string) => ({
    payload: h.suspendState[camera] ?? "0",
    send: (payload: number) => h.sendSuspend(camera, payload),
  }),
  useNotificationTest: () => ({
    payload: "",
    send: (payload: string) => h.sendTest(payload),
  }),
  useRestart: () => ({ payload: "", send: vi.fn() }),
}));

// The section form renders the extras the way FieldTemplate's `ui:before`
// does: with the section's form context as a prop.
vi.mock("@/components/config-form/ConfigForm", () => ({
  ConfigForm: ({ formContext }: { formContext?: ConfigFormContext }) => {
    const Extras = formContext?.renderers?.["NotificationsSettingsExtras"];
    return Extras ? <Extras formContext={formContext} /> : null;
  },
}));

vi.mock("@/hooks/use-config-schema", () => ({
  useSectionSchema: () => ({
    type: "object",
    properties: {
      enabled: { type: "boolean", default: false },
      email: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
    },
  }),
}));

vi.mock("@/hooks/use-is-admin", () => ({
  useIsAdmin: () => h.isAdmin,
}));

vi.mock("@/hooks/use-doc-domain", () => ({
  useDocDomain: () => ({
    getLocaleDocUrl: (path: string) => `https://docs.example/${path}`,
  }),
}));

vi.mock("@/hooks/use-date-locale", () => ({
  useDateLocale: () => undefined,
}));

vi.mock("@/hooks/use-date-utils", () => ({
  use24HourTime: () => true,
}));

vi.mock("@/utils/dateUtil", () => ({
  formatUnixTimestampToDateTime: (
    timestamp: number,
    options: { date_format?: string; timezone?: string },
  ) => `ts:${timestamp}:${options.timezone ?? ""}`,
}));

vi.mock("@/utils/isPWA", () => ({
  get isPWA() {
    return h.isPWA;
  },
}));

vi.mock("react-device-detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-device-detect")>()),
  get isIOS() {
    return h.isIOS;
  },
}));

vi.mock("@/components/camera/FriendlyNameLabel", () => ({
  CameraNameLabel: ({
    camera,
    htmlFor,
  }: {
    camera?: string;
    htmlFor?: string;
  }) => <label htmlFor={htmlFor}>{camera}</label>,
}));

function camera(
  name: string,
  order: number,
  notifications?: CameraFixture["notifications"],
  enabled = true,
): CameraFixture {
  const base = { name, enabled_in_config: enabled, ui: { order } };
  return notifications ? { ...base, notifications } : base;
}

function makeConfig(overrides: Partial<ConfigFixture> = {}): ConfigFixture {
  return {
    notifications: { enabled: false, email: "me@example.com" },
    cameras: {
      back: camera("back", 2, { enabled: false, enabled_in_config: false }),
      front: camera("front", 1, { enabled: true, enabled_in_config: true }),
      side: camera("side", 3),
      off: camera("off", 4, undefined, false),
      _replay_x: camera("_replay_x", 5, {
        enabled: true,
        enabled_in_config: true,
      }),
    },
    ui: { timezone: "UTC" },
    ...overrides,
  };
}

type FakeSubscription = { unsubscribe: ReturnType<typeof vi.fn> };

type FakeRegistration = {
  active: object | null;
  update: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  pushManager: {
    subscribe: ReturnType<typeof vi.fn>;
    getSubscription: ReturnType<typeof vi.fn>;
  };
};

function fakeRegistration(active: boolean): {
  registration: FakeRegistration;
  subscription: FakeSubscription;
} {
  const subscription: FakeSubscription = {
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  };
  const registration: FakeRegistration = {
    active: active ? {} : null,
    update: vi.fn(() => Promise.resolve()),
    unregister: vi.fn(() => Promise.resolve(true)),
    pushManager: {
      subscribe: vi.fn(() => Promise.resolve(subscription)),
      getSubscription: vi.fn(() => Promise.resolve(subscription)),
    },
  };
  return { registration, subscription };
}

const serviceWorker = {
  getRegistration: vi.fn<(path: string) => Promise<unknown>>(),
  register: vi.fn<(path: string, options: unknown) => Promise<unknown>>(),
};
const requestPermission = vi.fn<() => Promise<string>>();
const addMessage =
  vi.fn<
    (key: string, message: string, severity?: unknown, id?: string) => string
  >();
const removeMessage = vi.fn<(key: string, id: string) => void>();

function setSecureNotifications(available: boolean, secure = true) {
  if (available) {
    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: { requestPermission: () => requestPermission() },
    });
  } else {
    Reflect.deleteProperty(window, "Notification");
  }
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: secure,
  });
}

function renderExtras(formContext?: ConfigFormContext): {
  rerender: (next?: ConfigFormContext) => void;
} {
  const wrap = (ctx?: ConfigFormContext): ReactNode => (
    <MemoryRouter>
      <StatusBarMessagesContext.Provider
        value={{
          messages: {},
          addMessage,
          removeMessage,
          clearMessages: vi.fn(),
        }}
      >
        {ctx ? (
          <NotificationsSettingsExtras formContext={ctx} />
        ) : (
          <NotificationsSettingsExtras />
        )}
      </StatusBarMessagesContext.Provider>
    </MemoryRouter>
  );
  const result = render(wrap(formContext));
  return { rerender: (next) => result.rerender(wrap(next)) };
}

type PendingChange = (
  key: string,
  camera: string | undefined,
  data: ConfigSectionData | null,
) => void;

// Plays the settings page: keeps pending data keyed like Settings.tsx does,
// storing every update without comparing, and feeds it back through the form
// context.
function PendingHarness({
  onChange,
  extra,
}: Readonly<{ onChange: PendingChange; extra?: ConfigFormContext }>) {
  const [pending, setPending] = useState<Record<string, ConfigSectionData>>({});
  const onPendingDataChange = useCallback<PendingChange>(
    (key, camera, data) => {
      onChange(key, camera, data);
      const pendingKey = camera ? `${camera}::${key}` : key;
      setPending((prev) => {
        if (data === null) {
          const { [pendingKey]: _, ...rest } = prev;
          return rest;
        }
        return { ...prev, [pendingKey]: data };
      });
    },
    [onChange],
  );
  const ctx = useMemo<ConfigFormContext>(
    () => ({
      ...extra,
      level: "global",
      pendingDataBySection: pending,
      onPendingDataChange,
    }),
    [extra, pending, onPendingDataChange],
  );
  return (
    <StatusBarMessagesContext.Provider
      value={{
        messages: {},
        addMessage,
        removeMessage,
        clearMessages: vi.fn(),
      }}
    >
      <span data-testid="pending">{JSON.stringify(pending)}</span>
      <NotificationsSettingsExtras formContext={ctx} />
    </StatusBarMessagesContext.Provider>
  );
}

// Plays Settings.tsx around the real section: `handlePendingDataChange`
// stores whatever it is given, without comparing. `allow` bounds the number
// of stores so an update loop ends the test instead of hanging it.
function SettingsHarness({ allow }: Readonly<{ allow: () => boolean }>) {
  const [pending, setPending] = useState<Record<string, ConfigSectionData>>({});
  const onPendingDataChange = useCallback<PendingChange>(
    (key, camera, data) => {
      if (!allow()) {
        return;
      }
      const pendingKey = camera ? `${camera}::${key}` : key;
      setPending((prev) => {
        if (data === null) {
          const { [pendingKey]: _, ...rest } = prev;
          return rest;
        }
        return { ...prev, [pendingKey]: data };
      });
    },
    [allow],
  );
  return (
    <MemoryRouter>
      <StatusBarMessagesContext.Provider
        value={{
          messages: {},
          addMessage,
          removeMessage,
          clearMessages: vi.fn(),
        }}
      >
        <span data-testid="pending">{JSON.stringify(pending)}</span>
        <ConfigSection
          sectionPath="notifications"
          level="global"
          defaultConfig={{
            ...notificationsSection.base,
            ...notificationsSection.global,
          }}
          pendingDataBySection={pending}
          onPendingDataChange={onPendingDataChange}
        />
      </StatusBarMessagesContext.Provider>
    </MemoryRouter>
  );
}

function switchFor(label: string): HTMLElement {
  return screen.getByRole("switch", {
    name: (name) => name === label || name.startsWith(`${label} `),
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("NotificationsSettingsExtras", () => {
  beforeEach(() => {
    h.swr = { config: makeConfig(), "notifications/pubkey": "pub-key" };
    h.swrError = {};
    h.isAdmin = true;
    h.isIOS = false;
    h.isPWA = false;
    h.notificationState = {};
    h.suspendState = {};
    h.axiosPost.mockResolvedValue({});
    serviceWorker.getRegistration.mockResolvedValue(undefined);
    serviceWorker.register.mockResolvedValue(undefined);
    requestPermission.mockResolvedValue("granted");
    addMessage.mockReturnValue("id");
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    });
    setSecureNotifications(true);
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "Notification");
  });

  it("renders nothing below the global level", () => {
    renderExtras({ level: "camera" });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a loading indicator until the config loads", () => {
    h.swr = {};
    renderExtras();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("explains that notifications need a secure context", () => {
    setSecureNotifications(false, false);
    renderExtras();
    expect(
      screen.getByText("notification.notificationUnavailable.title"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("notification.notificationUnavailable.desc"),
    ).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://docs.example/configuration/notifications",
      "https://docs.example/configuration/authentication",
    ]);
    expect(serviceWorker.getRegistration).not.toHaveBeenCalled();
  });

  it("asks iOS browser tabs to install the app first", () => {
    h.isIOS = true;
    setSecureNotifications(false, true);
    renderExtras();
    expect(
      screen.getByText("notification.notificationUnavailable.descPwa"),
    ).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links[1]).toHaveAttribute(
      "href",
      "https://docs.example/configuration/notifications",
    );
  });

  it("lists enabled, non-replay cameras in order with the saved selection", async () => {
    renderExtras();
    await flush();
    expect(document.title).toBe("documentTitle.notifications");
    expect(screen.getByLabelText("notification.email.title")).toHaveValue(
      "me@example.com",
    );
    const switches = screen.getAllByRole("switch");
    expect(switches.map((s) => s.id)).toEqual([
      'cameras.all.title {"ns":"components/filter"}',
      "front",
      "back",
      "side",
    ]);
    expect(switchFor("cameras.all.title")).not.toBeChecked();
    expect(switchFor("front")).toBeChecked();
    expect(switchFor("back")).not.toBeChecked();
    // only front has notifications enabled in config
    expect(
      screen.getByText("notification.globalSettings.title"),
    ).toBeInTheDocument();
    expect(screen.getByText("notification.active")).toBeInTheDocument();
  });

  it("checks All cameras when notifications are enabled globally", async () => {
    h.swr["config"] = makeConfig({
      notifications: { enabled: true, email: "" },
    });
    renderExtras();
    await flush();
    expect(switchFor("cameras.all.title")).toBeChecked();
    expect(switchFor("front")).not.toBeChecked();
  });

  it("shows a message when there are no cameras", async () => {
    h.swr["config"] = makeConfig({ cameras: {} });
    renderExtras();
    await flush();
    expect(
      screen.getByText("notification.cameras.noCameras"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("register-device-hint")).toHaveAttribute(
      "data-blocker",
      "noCameras",
    );
  });

  it("hides the admin settings from viewers", async () => {
    h.isAdmin = false;
    renderExtras();
    await flush();
    expect(screen.queryByLabelText("notification.email.title")).toBeNull();
    expect(screen.queryByText("notification.globalSettings.title")).toBeNull();
    expect(
      screen.getByRole("button", { name: "notification.registerDevice" }),
    ).toBeEnabled();
  });

  it("syncs the email and enabled state into the section form data", async () => {
    const onFormDataChange = vi.fn<(data: ConfigSectionData) => void>();
    const ctx: ConfigFormContext = {
      level: "global",
      formData: { enabled: false, email: "form@example.com", extra: 1 },
      onFormDataChange,
    };
    renderExtras(ctx);
    await flush();
    expect(screen.getByLabelText("notification.email.title")).toHaveValue(
      "form@example.com",
    );
    expect(onFormDataChange).toHaveBeenLastCalledWith({
      enabled: false,
      email: "form@example.com",
      extra: 1,
    });

    fireEvent.change(screen.getByLabelText("notification.email.title"), {
      target: { value: "  " },
    });
    await flush();
    expect(onFormDataChange).toHaveBeenLastCalledWith({
      enabled: false,
      email: null,
      extra: 1,
    });
  });

  it("settles inside the real section when Settings stores every update", async () => {
    let stores = 0;
    const allow = () => ++stores <= 100;
    render(<SettingsHarness allow={allow} />);
    await flush();
    await flush();
    // a new form context each section render used to re-send the same data,
    // and each store re-rendered the section, forever
    expect(stores).toBeLessThan(10);

    fireEvent.change(screen.getByLabelText("notification.email.title"), {
      target: { value: "new@example.com" },
    });
    await flush();
    await flush();
    expect(stores).toBeLessThan(20);
    expect(screen.getByTestId("pending")).toHaveTextContent(
      '"notifications":{"enabled":false,"email":"new@example.com"}',
    );

    // picking a camera re-sent its override on every section render too
    fireEvent.click(switchFor("back"));
    await flush();
    await flush();
    expect(stores).toBeLessThan(30);
    expect(screen.getByTestId("pending")).toHaveTextContent(
      '"back::notifications":{"enabled":true}',
    );
  });

  it("falls back to the saved config when the form has no data", async () => {
    const onFormDataChange = vi.fn<(data: ConfigSectionData) => void>();
    const ctx: ConfigFormContext = { onFormDataChange };
    renderExtras(ctx);
    await flush();
    expect(onFormDataChange).toHaveBeenLastCalledWith({
      enabled: false,
      email: "me@example.com",
    });
  });

  it("turns camera selection changes into per-camera pending overrides", async () => {
    const onChange = vi.fn<PendingChange>();
    const setExtraHasChanges = vi.fn<(changed: boolean) => void>();
    const extra: ConfigFormContext = { setExtraHasChanges };
    render(<PendingHarness onChange={onChange} extra={extra} />);
    await flush();
    expect(setExtraHasChanges).toHaveBeenLastCalledWith(false);

    fireEvent.click(switchFor("back"));
    await flush();
    expect(switchFor("back")).toBeChecked();
    expect(setExtraHasChanges).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenCalledWith("notifications", "back", {
      enabled: true,
    });
    // side has no notifications config to override
    expect(onChange.mock.calls.some((call) => call[1] === "side")).toBe(false);
    expect(screen.getByTestId("pending")).toHaveTextContent(
      JSON.stringify({ "back::notifications": { enabled: true } }),
    );

    // switching back to the saved selection clears the pending overrides
    fireEvent.click(switchFor("back"));
    await flush();
    expect(onChange).toHaveBeenLastCalledWith("notifications", "back", null);
    expect(screen.getByTestId("pending")).toHaveTextContent("{}");
    expect(setExtraHasChanges).toHaveBeenLastCalledWith(false);
    expect(switchFor("back")).not.toBeChecked();
    expect(switchFor("front")).toBeChecked();
  });

  it("clears a camera override once it matches the saved value again", async () => {
    const onChange = vi.fn<PendingChange>();
    render(<PendingHarness onChange={onChange} />);
    await flush();

    fireEvent.click(switchFor("front"));
    await flush();
    expect(onChange).toHaveBeenCalledWith("notifications", "front", {
      enabled: false,
    });

    fireEvent.click(switchFor("back"));
    await flush();
    fireEvent.click(switchFor("front"));
    await flush();
    expect(onChange).toHaveBeenCalledWith("notifications", "front", null);
    expect(screen.getByTestId("pending")).toHaveTextContent(
      JSON.stringify({ "back::notifications": { enabled: true } }),
    );
  });

  it("selects every camera with All cameras", async () => {
    const onChange = vi.fn<PendingChange>();
    const onFormDataChange = vi.fn<(data: ConfigSectionData) => void>();
    const extra: ConfigFormContext = { onFormDataChange };
    render(<PendingHarness onChange={onChange} extra={extra} />);
    await flush();
    fireEvent.click(switchFor("cameras.all.title"));
    await flush();
    expect(switchFor("cameras.all.title")).toBeChecked();
    expect(switchFor("front")).not.toBeChecked();
    expect(onFormDataChange).toHaveBeenLastCalledWith({
      enabled: true,
      email: "me@example.com",
    });
    expect(onChange).toHaveBeenCalledWith("notifications", "back", {
      enabled: true,
    });
  });

  it("seeds the camera selection from pending camera overrides", async () => {
    const ctx: ConfigFormContext = {
      level: "global",
      pendingDataBySection: {
        "back::notifications": { enabled: true },
        "front::notifications": { enabled: false },
        "front::record": { enabled: true },
        "side::notifications": { other: 1 },
      },
    };
    const view = renderExtras(ctx);
    await flush();
    expect(switchFor("back")).toBeChecked();
    expect(switchFor("front")).not.toBeChecked();
    expect(switchFor("side")).not.toBeChecked();

    // when Undo All drops the pending data the form resets to the saved config
    view.rerender({ level: "global", pendingDataBySection: {} });
    await flush();
    expect(switchFor("front")).toBeChecked();
    expect(switchFor("back")).not.toBeChecked();
  });

  it("explains why Register is disabled", async () => {
    h.swr["notifications/pubkey"] = undefined;
    renderExtras();
    await flush();
    expect(
      screen.getByRole("button", { name: "notification.registerDevice" }),
    ).toBeDisabled();
    expect(screen.getByTestId("register-device-hint")).toHaveAttribute(
      "data-blocker",
      "keyLoading",
    );
  });

  it("reports a failed push key request", async () => {
    h.swr["notifications/pubkey"] = undefined;
    h.swrError["notifications/pubkey"] = new Error("boom");
    renderExtras();
    await flush();
    expect(screen.getByTestId("register-device-hint")).toHaveAttribute(
      "data-blocker",
      "keyUnavailable",
    );
  });

  it("asks to save first when notifications are off everywhere", async () => {
    h.swr["config"] = makeConfig({
      cameras: {
        back: camera("back", 1, { enabled: false, enabled_in_config: false }),
      },
    });
    renderExtras();
    await flush();
    fireEvent.click(switchFor("back"));
    await flush();
    expect(screen.getByTestId("register-device-hint")).toHaveAttribute(
      "data-blocker",
      "notSaved",
    );
  });

  it("registers this device and subscribes to push", async () => {
    const { registration, subscription } = fakeRegistration(true);
    serviceWorker.register.mockResolvedValue(registration);
    renderExtras();
    await flush();
    expect(serviceWorker.getRegistration).toHaveBeenCalledWith(
      "/notifications-worker.js",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "notification.registerDevice" }),
    );
    await waitFor(() =>
      expect(h.axiosPost).toHaveBeenCalledWith("notifications/register", {
        sub: subscription,
      }),
    );
    expect(serviceWorker.register).toHaveBeenCalledWith(
      "/notifications-worker.js",
      { updateViaCache: "none" },
    );
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: "pub-key",
    });
    expect(addMessage).toHaveBeenCalledWith(
      "notification_settings",
      "notification.unsavedRegistrations",
      undefined,
      "registration",
    );
    expect(h.toastSuccess).toHaveBeenCalledWith(
      "notification.toast.success.registered",
    );
    // the visible label flips, but the aria-label stays "registerDevice"
    expect(
      screen.getByRole("button", { name: "notification.registerDevice" }),
    ).toHaveTextContent("notification.unregisterDevice");
    fireEvent.click(
      screen.getByRole("button", { name: "notification.sendTestNotification" }),
    );
    expect(h.sendTest).toHaveBeenCalledWith("notification_test");
  });

  it("rolls back the registration when the server rejects it", async () => {
    const { registration, subscription } = fakeRegistration(true);
    serviceWorker.register.mockResolvedValue(registration);
    h.axiosPost.mockRejectedValue(new Error("nope"));
    renderExtras();
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "notification.registerDevice" }),
    );
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(
        "notification.toast.error.registerFailed",
      ),
    );
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(registration.unregister).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "notification.registerDevice" }),
      ).toHaveTextContent("notification.registerDevice"),
    );
  });

  it("waits for a new worker to activate before subscribing", async () => {
    const { registration } = fakeRegistration(false);
    serviceWorker.register.mockResolvedValue(registration);
    renderExtras();
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "notification.registerDevice" }),
    );
    await flush();
    await flush();
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    await waitFor(
      () => expect(registration.pushManager.subscribe).toHaveBeenCalled(),
      { timeout: 2000 },
    );
  });

  it("does nothing when permission is denied", async () => {
    requestPermission.mockResolvedValue("denied");
    renderExtras();
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "notification.registerDevice" }),
    );
    await flush();
    expect(requestPermission).toHaveBeenCalled();
    expect(serviceWorker.register).not.toHaveBeenCalled();
  });

  it("unregisters an existing registration", async () => {
    const { registration, subscription } = fakeRegistration(true);
    serviceWorker.getRegistration.mockResolvedValue(registration);
    renderExtras();
    const unregister = await screen.findByText("notification.unregisterDevice");
    expect(registration.update).toHaveBeenCalled();
    fireEvent.click(unregister);
    await waitFor(() =>
      expect(removeMessage).toHaveBeenCalledWith(
        "notification_settings",
        "registration",
      ),
    );
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(registration.unregister).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "notification.registerDevice" }),
    ).toHaveTextContent("notification.registerDevice");
  });

  it("treats a failed registration lookup as unregistered", async () => {
    serviceWorker.getRegistration.mockRejectedValue(new Error("blocked"));
    renderExtras();
    await flush();
    expect(
      screen.getByRole("button", { name: "notification.registerDevice" }),
    ).toBeInTheDocument();
  });
});

describe("CameraNotificationSwitch", () => {
  beforeEach(() => {
    h.notificationState = {};
    h.suspendState = {};
    Element.prototype.scrollIntoView = () => undefined;
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.releasePointerCapture = () => undefined;
  });

  function renderSwitch() {
    return render(<CameraNotificationSwitch camera="front" />);
  }

  function chooseSuspend(label: string) {
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    const option = screen.getByRole("option", { name: label });
    fireEvent.keyDown(option, { key: "Enter" });
  }

  it("shows an active camera with suspend options", () => {
    renderSwitch();
    expect(screen.getByText("front")).toBeInTheDocument();
    expect(screen.getByText("notification.active")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveTextContent(
      "notification.suspendTime.suspend",
    );
  });

  it("suspends for a number of minutes", () => {
    renderSwitch();
    chooseSuspend("notification.suspendTime.30minutes");
    expect(h.sendSuspend).toHaveBeenCalledWith("front", 30);
    expect(h.sendNotification).not.toHaveBeenCalled();
  });

  it("turns notifications off until restart", () => {
    renderSwitch();
    chooseSuspend("notification.suspendTime.untilRestart");
    expect(h.sendNotification).toHaveBeenCalledWith("front", "OFF");
  });

  it("shows notifications off until restart and cancels the suspension", () => {
    h.notificationState["front"] = "OFF";
    renderSwitch();
    expect(
      screen.getByText(
        `notification.suspended ${JSON.stringify({
          time: 'time.untilForRestart {"ns":"common"}',
        })}`,
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "notification.cancelSuspension" }),
    );
    expect(h.sendNotification).toHaveBeenCalledWith("front", "ON");
    expect(h.sendSuspend).toHaveBeenCalledWith("front", 0);
  });

  it("shows when a timed suspension ends", () => {
    h.suspendState["front"] = "1700000000";
    renderSwitch();
    const status = screen.getByText(/^notification\.suspended/);
    expect(status.textContent).toContain("time.untilForTime");
    expect(status.textContent).toContain("ts:1700000000:");
    expect(
      within(status.parentElement ?? status).queryByText("notification.active"),
    ).toBeNull();
  });
});
