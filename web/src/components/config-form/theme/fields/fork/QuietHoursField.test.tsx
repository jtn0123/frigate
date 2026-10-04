import { fireEvent, render, screen, within } from "@testing-library/react";
import type { FieldProps, RJSFSchema } from "@rjsf/utils";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuietWindow } from "@/lib/fork/notification-schedule";
import { QuietHoursField } from "./QuietHoursField";

const auth = vi.hoisted(() => ({ admin: true }));
vi.mock("@/hooks/use-is-admin", () => ({ useIsAdmin: () => auth.admin }));

// The browser's own zone, which the server's clock is compared with
const browser = vi.hoisted(() => ({ zone: "UTC" }));
vi.mock("@/lib/fork/notification-schedule", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/fork/notification-schedule")
  >()),
  browserTimeZone: () => browser.zone,
}));

const server = vi.hoisted(() => ({
  schedule: { timezone: "UTC", source: "server", now: 0, cameras: {} } as
    Record<string, unknown> | undefined,
}));
vi.mock("swr", () => ({
  default: (key: string | null) => ({
    data: key === "fork/notifications/schedule" ? server.schedule : undefined,
  }),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en-US" },
    t: (key: string, options?: Record<string, unknown>) =>
      options === undefined ? key : `${key}:${JSON.stringify(options)}`,
  }),
}));

const SCHEMA: RJSFSchema = {
  type: "array",
  title: "Quiet hours",
  description: "When pushes are held back",
  items: {
    type: "object",
    properties: {
      days: { type: "array", title: "Days" },
      start: { type: "string", title: "Start time" },
      end: { type: "string", title: "End time" },
    },
  },
};

const camera = (name: string, order: number, notifications: object) => ({
  name,
  enabled_in_config: true,
  ui: { order },
  notifications: { enabled: true, ...notifications },
});

const NIGHTLY: QuietWindow[] = [{ days: [], start: "22:00", end: "07:00" }];

function config(global: QuietWindow[]) {
  return {
    ui: { time_format: "24hour" },
    notifications: { enabled: true, quiet_hours: global },
    cameras: {
      front_door: camera("front_door", 0, { quiet_hours: global }),
      backyard: camera("backyard", 1, { quiet_hours: [] }),
      garage: camera("garage", 2, { enabled: false, quiet_hours: global }),
    },
  };
}

type HarnessProps = {
  /** The saved windows, which the badge and the status read. */
  saved: unknown;
  /** The windows as edited; the saved ones when left out. */
  draft?: unknown;
  context?: Record<string, unknown>;
  onSaved?: (windows: unknown) => void;
};

function LocationProbe() {
  const location = useLocation();
  return (
    <span data-testid="location">{`${location.pathname}${location.search}`}</span>
  );
}

function Harness({
  saved,
  draft = saved,
  context,
  onSaved,
}: Readonly<HarnessProps>) {
  const [formData, setFormData] = useState<unknown>(draft);
  const props: unknown = {
    name: "quiet_hours",
    schema: SCHEMA,
    uiSchema: {},
    formData,
    onChange: (next: unknown, path: unknown) => {
      setFormData(next);
      onSaved?.({ next, path });
    },
    fieldPathId: { path: ["quiet_hours"], $id: "root_quiet_hours" },
    errorSchema: {},
    registry: {
      formContext: {
        level: "global",
        fullConfig: config(NIGHTLY),
        formData: { enabled: true },
        baselineFormData: { enabled: true, quiet_hours: saved },
        sectionI18nPrefix: "notifications",
        ...context,
      },
    },
  };
  return (
    <MemoryRouter initialEntries={["/settings?page=notifications"]}>
      <QuietHoursField {...(props as FieldProps)} />
      <LocationProbe />
    </MemoryRouter>
  );
}

beforeEach(() => {
  // Wednesday 2026-01-14 23:30 UTC, inside the nightly window
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.UTC(2026, 0, 14, 23, 30)));
  auth.admin = true;
  browser.zone = "UTC";
  server.schedule = { timezone: "UTC", source: "server", now: 0, cameras: {} };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("QuietHoursField", () => {
  it("shows the global schedule, its state, and each camera", () => {
    render(<Harness saved={NIGHTLY} />);

    expect(screen.getByTestId("quiet-status-scope")).toHaveAttribute(
      "data-state",
      "quiet",
    );
    expect(screen.getByTestId("quiet-status-text")).toHaveTextContent(
      'notificationSchedule.status.quietUntil:{"when":"notificationSchedule.when.tomorrow:{\\"time\\":\\"07:00\\"}"}',
    );
    expect(screen.queryByTestId("quiet-status-draft")).not.toBeInTheDocument();
    expect(
      screen.getByText(/notificationSchedule.timezone.server/),
    ).toHaveTextContent('{"zone":"UTC"}');
    expect(
      screen.queryByTestId("quiet-timezone-warning"),
    ).not.toBeInTheDocument();
    // backyard keeps its own empty list, garage has notifications off
    expect(screen.getByTestId("quiet-status-front_door")).toHaveAttribute(
      "data-state",
      "quiet",
    );
    expect(screen.getByTestId("quiet-status-backyard")).toHaveAttribute(
      "data-state",
      "notifying",
    );
    expect(screen.getByTestId("quiet-status-garage")).toHaveAttribute(
      "data-state",
      "off",
    );
    expect(
      within(screen.getByTestId("quiet-camera-backyard")).getByText(
        "notificationSchedule.cameras.ownNone",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("quiet-camera-front_door")).getByRole("link"),
    ).toHaveAttribute(
      "href",
      "/settings?page=cameraNotifications&camera=front_door",
    );
  });

  it("adds, edits, and removes windows through the form", () => {
    const onSaved = vi.fn();
    render(<Harness saved={[]} onSaved={onSaved} />);
    expect(
      screen.getByText("notificationSchedule.windows.empty"),
    ).toBeInTheDocument();
    // The empty editor says it already; no second "No quiet hours" line
    expect(screen.queryByTestId("quiet-status-text")).not.toBeInTheDocument();
    expect(screen.getByTestId("quiet-status-scope")).toHaveAttribute(
      "data-state",
      "notifying",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "notificationSchedule.windows.add" }),
    );
    expect(onSaved).toHaveBeenLastCalledWith({
      next: [{ days: [], start: "22:00", end: "07:00" }],
      path: ["quiet_hours"],
    });
    // Nothing is saved yet: the badge stays put and a line says what changes
    expect(screen.getByTestId("quiet-status-scope")).toHaveAttribute(
      "data-state",
      "notifying",
    );
    expect(screen.getByTestId("quiet-status-text")).toHaveTextContent(
      "notificationSchedule.status.noWindows",
    );
    expect(screen.getByTestId("quiet-status-draft")).toHaveTextContent(
      "notificationSchedule.afterSaving.quiet",
    );

    const row = screen.getByRole("group", {
      name: 'notificationSchedule.windows.label:{"index":1}',
    });
    fireEvent.click(within(row).getByRole("button", { name: "Saturday" }));
    fireEvent.click(within(row).getByRole("button", { name: "Sunday" }));
    fireEvent.change(within(row).getByLabelText("Start time"), {
      target: { value: "23:00" },
    });
    fireEvent.change(within(row).getByLabelText("End time"), {
      target: { value: "06:30" },
    });
    expect(onSaved).toHaveBeenLastCalledWith({
      next: [
        {
          days: ["mon", "tue", "wed", "thu", "fri"],
          start: "23:00",
          end: "06:30",
        },
      ],
      path: ["quiet_hours"],
    });
    expect(within(row).getByRole("button", { name: "Sunday" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Past midnight, the chips are the nights it starts on, Mon to Fri
    expect(
      within(row).getByTestId("quiet-window-days-label"),
    ).toHaveTextContent("notificationSchedule.windows.startsOn");
    expect(
      within(row).getByText(/notificationSchedule.windows.summary/),
    ).toHaveTextContent(/windows\.nights.*Mon.*Fri/);
    expect(
      within(row).getByText(/notificationSchedule.windows.endsMornings/),
    ).toHaveTextContent(/Tue.*Sat/);

    fireEvent.change(within(row).getByLabelText("End time"), {
      target: { value: "23:30" },
    });
    expect(
      within(row).getByTestId("quiet-window-days-label"),
    ).toHaveTextContent("Days");
    expect(
      within(row).getByText(/notificationSchedule.windows.summary/),
    ).toHaveTextContent("notificationSchedule.windows.weekdays");

    fireEvent.click(
      within(row).getByRole("button", {
        name: 'notificationSchedule.windows.remove:{"index":1}',
      }),
    );
    expect(onSaved).toHaveBeenLastCalledWith({
      next: [],
      path: ["quiet_hours"],
    });
  });

  it("shows the saved state, not unsaved edits, and what saving would do", () => {
    // Saved: the nightly window, quiet at 23:30. Edited: no windows at all.
    render(<Harness saved={NIGHTLY} draft={[]} />);

    expect(screen.getByTestId("quiet-status-scope")).toHaveAttribute(
      "data-state",
      "quiet",
    );
    expect(screen.getByTestId("quiet-status-text")).toHaveTextContent(
      "notificationSchedule.status.quietUntil",
    );
    expect(screen.getByTestId("quiet-status-draft")).toHaveTextContent(
      "notificationSchedule.afterSaving.none",
    );
    expect(screen.getByTestId("quiet-status-draft")).toHaveClass(
      "text-unsaved",
    );
    // The front door uses the saved global window until the edit is saved
    expect(screen.getByTestId("quiet-status-front_door")).toHaveAttribute(
      "data-state",
      "quiet",
    );
  });

  it("says when saving a window would make it quiet now", () => {
    render(
      <Harness
        saved={[]}
        draft={[{ days: [], start: "09:00", end: "09:00" }]}
      />,
    );
    expect(screen.getByTestId("quiet-status-scope")).toHaveAttribute(
      "data-state",
      "notifying",
    );
    expect(screen.getByTestId("quiet-status-text")).toHaveTextContent(
      "notificationSchedule.status.noWindows",
    );
    expect(screen.getByTestId("quiet-status-draft")).toHaveTextContent(
      'notificationSchedule.afterSaving.quiet:{"status":"notificationSchedule.status.alwaysQuiet"}',
    );
  });

  it("says when saving would turn notifications off", () => {
    render(
      <Harness saved={NIGHTLY} context={{ formData: { enabled: false } }} />,
    );
    expect(screen.getByTestId("quiet-status-scope")).toHaveAttribute(
      "data-state",
      "quiet",
    );
    expect(screen.getByTestId("quiet-status-draft")).toHaveTextContent(
      "notificationSchedule.afterSaving.off",
    );
  });

  it("warns when the server's clock decides and is off this browser's", () => {
    browser.zone = "America/Los_Angeles";
    const onPendingDataChange = vi.fn();
    render(<Harness saved={NIGHTLY} context={{ onPendingDataChange }} />);

    // January in Los Angeles is UTC-8, so the server runs 8 hours ahead
    const warning = screen.getByTestId("quiet-timezone-warning");
    expect(warning).toHaveTextContent(
      'notificationSchedule.timezone.serverAhead:{"zone":"UTC","count":8}',
    );
    expect(
      screen.queryByText(/notificationSchedule.timezone.server:/),
    ).not.toBeInTheDocument();

    // The browser's zone becomes an unsaved change on the UI settings page
    fireEvent.click(
      within(warning).getByRole("button", {
        name: 'notificationSchedule.timezone.useBrowser:{"zone":"America/Los_Angeles"}',
      }),
    );
    expect(onPendingDataChange).toHaveBeenCalledWith("ui", undefined, {
      time_format: "24hour",
      timezone: "America/Los_Angeles",
    });
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/settings?page=systemUi",
    );
  });

  it("says how far behind a server clock is, or that it only drifts later", () => {
    server.schedule = {
      timezone: "America/New_York",
      source: "server",
      now: 0,
      cameras: {},
    };
    const { unmount } = render(<Harness saved={NIGHTLY} />);
    expect(screen.getByTestId("quiet-timezone-warning")).toHaveTextContent(
      'notificationSchedule.timezone.serverBehind:{"zone":"America/New_York","count":5}',
    );
    unmount();

    // London keeps UTC time in January, but not in summer
    browser.zone = "Europe/London";
    server.schedule = {
      timezone: "UTC",
      source: "server",
      now: 0,
      cameras: {},
    };
    render(<Harness saved={NIGHTLY} />);
    expect(screen.getByTestId("quiet-timezone-warning")).toHaveTextContent(
      "notificationSchedule.timezone.serverSeasonal",
    );
  });

  it("keeps the quiet zone line for a UI timezone", () => {
    browser.zone = "America/Los_Angeles";
    server.schedule = {
      timezone: "Asia/Tokyo",
      source: "ui",
      now: 0,
      cameras: {},
    };
    const fullConfig = {
      ...config(NIGHTLY),
      ui: { time_format: "24hour", timezone: "Asia/Tokyo" },
    };
    render(<Harness saved={NIGHTLY} context={{ fullConfig }} />);
    expect(
      screen.queryByTestId("quiet-timezone-warning"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/notificationSchedule.timezone.ui/),
    ).toHaveTextContent(/browserDiffers.*America\/Los_Angeles/);
  });

  it("says what is never held, and where held alerts go, on a camera too", () => {
    render(
      <Harness
        saved={NIGHTLY}
        context={{ level: "camera", cameraName: "front_door" }}
      />,
    );
    expect(screen.getByText("notificationSchedule.intro")).toBeInTheDocument();
    expect(screen.getByTestId("quiet-hours-exempt")).toHaveTextContent(
      "notificationSchedule.exempt",
    );
    // The card's own intro replaces the generated description
    expect(
      screen.queryByText("When pushes are held back"),
    ).not.toBeInTheDocument();
  });

  it("keeps a half typed window and flags the missing time", () => {
    render(
      <Harness
        saved={[]}
        draft={[{ days: ["mon"], start: "", end: "07:00" }]}
      />,
    );
    const row = screen.getByRole("group", {
      name: 'notificationSchedule.windows.label:{"index":1}',
    });
    expect(within(row).getByLabelText("Start time")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      within(row).getByText("notificationSchedule.windows.invalidTime"),
    ).toBeInTheDocument();
  });

  it("marks a full day window", () => {
    render(<Harness saved={[{ days: [], start: "08:00", end: "08:00" }]} />);
    expect(
      screen.getByText("notificationSchedule.windows.fullDay"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("quiet-status-text")).toHaveTextContent(
      "notificationSchedule.status.alwaysQuiet",
    );
  });

  it("tells a camera whether it uses the global schedule", () => {
    const context = { level: "camera", cameraName: "front_door" };
    const { unmount } = render(<Harness saved={NIGHTLY} context={context} />);
    expect(
      screen.getByText("notificationSchedule.scope.inherits"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("quiet-camera-list")).not.toBeInTheDocument();
    unmount();

    render(<Harness saved={[]} context={context} />);
    expect(
      screen.getByText("notificationSchedule.scope.own"),
    ).toBeInTheDocument();
  });

  it("explains a profile schedule and an off camera", () => {
    render(
      <Harness
        saved={NIGHTLY}
        context={{
          level: "camera",
          cameraName: "garage",
          isProfile: true,
          formData: { enabled: false },
          baselineFormData: { enabled: false, quiet_hours: NIGHTLY },
        }}
      />,
    );
    expect(
      screen.getByText("notificationSchedule.scope.profile"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("quiet-status-scope")).toHaveAttribute(
      "data-state",
      "off",
    );
    expect(screen.queryByTestId("quiet-status-text")).not.toBeInTheDocument();
  });

  it("names the UI timezone and reads the windows on it", () => {
    server.schedule = undefined;
    const fullConfig = {
      ...config(NIGHTLY),
      ui: { time_format: "24hour", timezone: "Asia/Tokyo" },
    };
    // 23:30 UTC is 08:30 on Thursday in Tokyo, after the window
    render(<Harness saved={NIGHTLY} context={{ fullConfig }} />);
    expect(
      screen.getByText(/notificationSchedule.timezone.ui/),
    ).toHaveTextContent('{"zone":"Asia/Tokyo"}');
    expect(screen.getByTestId("quiet-status-scope")).toHaveAttribute(
      "data-state",
      "notifying",
    );
  });

  it("is hidden from viewers", () => {
    auth.admin = false;
    render(<Harness saved={NIGHTLY} />);
    expect(screen.queryByTestId("quiet-hours-field")).not.toBeInTheDocument();
  });
});
