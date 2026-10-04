/** Fork (D78): edit the windows when alert pushes are held back. */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { LuPlus, LuTrash2 } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_WINDOW,
  isFullDay,
  isOvernight,
  isValidTime,
  startsOn,
  toggleDay,
  WEEKDAYS,
  weekdayName,
  type QuietWindow,
  type Weekday,
} from "@/lib/fork/notification-schedule";
import { phoneTouch } from "@/lib/fork/phone";
import { cn } from "@/lib/utils";

import { useScheduleText, type TimeFormat } from "./use-schedule-text";

export type QuietHoursLabels = {
  days: string;
  start: string;
  end: string;
};

type QuietHoursEditorProps = {
  idPrefix: string;
  windows: QuietWindow[];
  onChange: (next: QuietWindow[]) => void;
  labels: QuietHoursLabels;
  format: TimeFormat;
  disabled?: boolean | undefined;
};

export function QuietHoursEditor({
  idPrefix,
  windows,
  onChange,
  labels,
  format,
  disabled,
}: Readonly<QuietHoursEditorProps>) {
  const { t } = useTranslation(["fork"]);

  const update = useCallback(
    (index: number, patch: Partial<QuietWindow>) =>
      onChange(
        windows.map((window, i) =>
          i === index ? { ...window, ...patch } : window,
        ),
      ),
    [onChange, windows],
  );

  return (
    <div className="space-y-3" data-testid="quiet-hours-editor">
      {windows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("notificationSchedule.windows.empty")}
        </p>
      ) : (
        <ul className="space-y-3">
          {windows.map((window, index) => (
            <QuietWindowRow
              // The list has no stable ids; rows only move by removal
              key={index}
              id={`${idPrefix}-${index}`}
              index={index}
              window={window}
              labels={labels}
              format={format}
              disabled={disabled}
              onChange={(patch) => update(index, patch)}
              onRemove={() => onChange(windows.filter((_, i) => i !== index))}
            />
          ))}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-2"
        disabled={disabled}
        onClick={() => onChange([...windows, { ...DEFAULT_WINDOW }])}
      >
        <LuPlus className="size-4" aria-hidden />
        {t("notificationSchedule.windows.add")}
      </Button>
    </div>
  );
}

type QuietWindowRowProps = {
  id: string;
  index: number;
  window: QuietWindow;
  labels: QuietHoursLabels;
  format: TimeFormat;
  disabled?: boolean | undefined;
  onChange: (patch: Partial<QuietWindow>) => void;
  onRemove: () => void;
};

function QuietWindowRow({
  id,
  index,
  window,
  labels,
  format,
  disabled,
  onChange,
  onRemove,
}: Readonly<QuietWindowRowProps>) {
  const { t } = useTranslation(["fork"]);
  const name = t("notificationSchedule.windows.label", { index: index + 1 });
  const { windowText, endText } = useScheduleText(format);
  const summary = windowText(window);
  const ends = endText(window);
  const complete = isValidTime(window.start) && isValidTime(window.end);
  // A window past midnight (or a full day) belongs to the day it starts on
  const daysLabel =
    complete && isOvernight(window)
      ? t("notificationSchedule.windows.startsOn")
      : labels.days;

  return (
    <li
      role="group"
      aria-label={name}
      className="space-y-3 rounded-lg bg-secondary p-3"
      data-testid="quiet-window"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1.5">
          <span className="text-sm font-medium">{summary ?? name}</span>
          {complete && isFullDay(window) && (
            <WindowTag>{t("notificationSchedule.windows.fullDay")}</WindowTag>
          )}
          {ends && <WindowTag>{ends}</WindowTag>}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          disabled={disabled}
          aria-label={t("notificationSchedule.windows.remove", {
            index: index + 1,
          })}
          onClick={onRemove}
        >
          <LuTrash2 className="size-4" aria-hidden />
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <span
          id={`${id}-days`}
          className="text-xs text-muted-foreground"
          data-testid="quiet-window-days-label"
        >
          {daysLabel}
        </span>
        <div
          role="group"
          aria-labelledby={`${id}-days`}
          // seven equal columns keep the week on one row on a phone
          className="grid grid-cols-7 gap-1 sm:flex sm:flex-wrap"
        >
          {WEEKDAYS.map((day: Weekday, weekday) => {
            const on = startsOn(window, day);
            return (
              <Button
                key={day}
                type="button"
                size="sm"
                variant={on ? "select" : "outline"}
                // focus-visible:ring-selected: the default theme's --ring
                // is not a valid color, so the stock focus ring draws nothing
                className="h-9 min-w-0 px-0 text-xs focus-visible:ring-selected sm:min-w-11 sm:px-2"
                disabled={disabled}
                aria-pressed={on}
                aria-label={weekdayName(weekday, format.locale, "long")}
                onClick={() => onChange({ days: toggleDay(window.days, day) })}
              >
                {weekdayName(weekday, format.locale)}
              </Button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <TimeInput
          id={`${id}-start`}
          label={labels.start}
          value={window.start}
          disabled={disabled}
          onChange={(start) => onChange({ start })}
        />
        <TimeInput
          id={`${id}-end`}
          label={labels.end}
          value={window.end}
          disabled={disabled}
          onChange={(end) => onChange({ end })}
        />
      </div>
    </li>
  );
}

function WindowTag({ children }: Readonly<{ children: string }>) {
  return (
    <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

type TimeInputProps = {
  id: string;
  label: string;
  value: string;
  disabled?: boolean | undefined;
  onChange: (value: string) => void;
};

function TimeInput({
  id,
  label,
  value,
  disabled,
  onChange,
}: Readonly<TimeInputProps>) {
  const { t } = useTranslation(["fork"]);
  const invalid = !isValidTime(value);
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="time"
        step={60}
        required
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        className={cn(
          // 44 px tall on a phone, like the day chips next to it
          phoneTouch ? "h-11" : "h-9",
          "w-32 bg-background dark:[color-scheme:dark]",
          invalid && "border-destructive",
        )}
        onChange={(event) => onChange(event.target.value)}
      />
      {invalid && (
        <span id={`${id}-error`} className="text-xs text-destructive">
          {t("notificationSchedule.windows.invalidTime")}
        </span>
      )}
    </div>
  );
}
