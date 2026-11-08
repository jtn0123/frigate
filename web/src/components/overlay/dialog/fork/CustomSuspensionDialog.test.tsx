import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomSuspensionDialog from "../CustomSuspensionDialog";

type CalendarProps = {
  timezone?: string;
  selectedDay?: Date;
  disabled?: { before: Date };
  onSelect: (day?: Date) => void;
};

const h = vi.hoisted(() => ({
  timezone: undefined as string | undefined,
  calendar: null as CalendarProps | null,
  pickDay: undefined as Date | undefined,
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string) => key,
  }),
}));

vi.mock("swr", () => ({
  default: (key: string) => ({
    data: key === "config" ? { ui: { timezone: h.timezone } } : undefined,
  }),
}));

vi.mock("@/hooks/use-date-utils", () => ({
  useFormattedTimestamp: (timestamp: number, format: string, tz?: string) =>
    `date:${timestamp}:${format}:${tz ?? ""}`,
}));

// The real calendar is exercised by the e2e spec; here it reports the props
// the dialog passes and picks the day a test asks for.
vi.mock("@/components/overlay/ReviewActivityCalendar", () => ({
  TimezoneAwareCalendar: (props: CalendarProps) => {
    h.calendar = props;
    return (
      <button type="button" onClick={() => props.onSelect(h.pickDay)}>
        pick-day
      </button>
    );
  },
}));

// Mid-July, far from a DST change in either hemisphere, so the minute counts
// below hold in whatever zone the test runner uses.
const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
const MINUTE = 60_000;

function renderDialog(open = true) {
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const onConfirm = vi.fn<(minutes: number) => void>();
  const view = render(
    <CustomSuspensionDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />,
  );
  return { ...view, onOpenChange, onConfirm };
}

function timeInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(
    "notification.customSuspension.untilLabel",
  );
}

function apply(): HTMLElement {
  return screen.getByRole("button", { name: "button.apply" });
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function localTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe("CustomSuspensionDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    h.timezone = undefined;
    h.calendar = null;
    h.pickDay = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing while closed", () => {
    renderDialog(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts an hour from now and suspends for that long", () => {
    const { onConfirm, onOpenChange } = renderDialog();

    expect(
      screen.getByText("notification.customSuspension.title"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("notification.customSuspension.description"),
    ).toBeInTheDocument();
    expect(timeInput().value).toBe(localTime(NOW + 60 * MINUTE));
    expect(
      screen.getByRole("button", {
        name: `date:${(NOW + 60 * MINUTE) / 1000}:time.formattedTimestampMonthDayYear.24hour:`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("notification.customSuspension.invalidTime"),
    ).toBeNull();

    fireEvent.click(apply());

    expect(onConfirm).toHaveBeenCalledWith(60);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes without suspending on Cancel", () => {
    const { onConfirm, onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "button.cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("reads and writes the time of day in the configured timezone", () => {
    // UTC+05:00 is parsed without Intl, so it is the same on every runner
    h.timezone = "UTC+05:00";
    const { onConfirm } = renderDialog();

    // an hour from noon UTC is 18:00 in UTC+05:00
    expect(timeInput().value).toBe("18:00");

    fireEvent.change(timeInput(), { target: { value: "19:30" } });
    expect(timeInput().value).toBe("19:30");
    fireEvent.click(apply());

    expect(onConfirm).toHaveBeenCalledWith(150);
  });

  it("treats an unknown timezone as the browser's", () => {
    h.timezone = "Not/AZone";
    renderDialog();

    expect(timeInput().value).toBe(localTime(NOW + 60 * MINUTE));
  });

  it("refuses a time in the past", () => {
    // a fixed zone keeps the earlier time on the same day on every runner
    h.timezone = "UTC+05:00";
    const { onConfirm } = renderDialog();

    // 16:00 in UTC+05:00 is an hour ago
    fireEvent.change(timeInput(), { target: { value: "16:00" } });

    expect(
      screen.getByText("notification.customSuspension.invalidTime"),
    ).toBeInTheDocument();
    expect(apply()).toBeDisabled();
    fireEvent.click(apply());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ignores a cleared time field", () => {
    renderDialog();
    const before = timeInput().value;

    fireEvent.change(timeInput(), { target: { value: "" } });

    expect(timeInput().value).toBe(before);
  });

  it("does not suspend once the chosen time has passed", () => {
    const { onConfirm, onOpenChange } = renderDialog();

    // the clock moves past the chosen time while the dialog is open
    vi.setSystemTime(NOW + 2 * 60 * MINUTE);
    fireEvent.click(apply());

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByText("notification.customSuspension.invalidTime"),
    ).toBeInTheDocument();
  });

  it("moves to a picked day and keeps the time of day", () => {
    h.timezone = "UTC+05:00";
    const { onConfirm } = renderDialog();

    fireEvent.click(
      screen.getByRole("button", { name: /^date:.*:UTC\+05:00$/ }),
    );
    // only today onward can be picked, and the calendar shares the timezone
    expect(h.calendar?.timezone).toBe("UTC+05:00");
    const before = h.calendar?.disabled?.before;
    expect(before?.getHours()).toBe(0);
    expect(before?.getDate()).toBe(15);
    expect(h.calendar?.selectedDay?.getHours()).toBe(18);

    // a cleared selection changes nothing
    fireEvent.click(screen.getByRole("button", { name: "pick-day" }));
    expect(screen.getByRole("button", { name: "pick-day" })).toBeVisible();

    h.pickDay = new Date(2026, 6, 20);
    fireEvent.click(screen.getByRole("button", { name: "pick-day" }));

    // the popover closes on a pick
    expect(screen.queryByRole("button", { name: "pick-day" })).toBeNull();
    expect(timeInput().value).toBe("18:00");
    fireEvent.click(apply());

    // five days and an hour
    expect(onConfirm).toHaveBeenCalledWith(5 * 24 * 60 + 60);
  });

  it("starts again from an hour ahead each time it opens", () => {
    const { rerender, onOpenChange, onConfirm } = renderDialog();
    fireEvent.change(timeInput(), {
      target: { value: localTime(NOW + 3 * 60 * MINUTE) },
    });

    act(() => {
      rerender(
        <CustomSuspensionDialog
          open={false}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />,
      );
    });
    vi.setSystemTime(NOW + 30 * MINUTE);
    act(() => {
      rerender(
        <CustomSuspensionDialog
          open
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />,
      );
    });

    expect(timeInput().value).toBe(localTime(NOW + 90 * MINUTE));
  });
});
