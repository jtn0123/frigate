import { renderHook } from "@testing-library/react";
import i18next from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import fork from "../../../../public/locales/en/fork.json";
import type { Weekday } from "@/lib/fork/notification-schedule";

import { useScheduleText } from "./use-schedule-text";

// The real English strings, so a sentence that reads wrong fails here
const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    ns: ["fork"],
    resources: { en: { fork } },
    interpolation: { escapeValue: false },
  });
});

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

function scheduleText() {
  const text = renderHook(
    () => useScheduleText({ locale: "en-US", hour12: true }),
    { wrapper },
  ).result.current;
  // Intl puts a narrow no-break space before AM and PM
  const plain = (value: string | undefined) => value?.replace(/\s/g, " ");
  return {
    statusText: (...args: Parameters<typeof text.statusText>) =>
      plain(text.statusText(...args)),
    windowText: (...args: Parameters<typeof text.windowText>) =>
      plain(text.windowText(...args)),
    endText: (...args: Parameters<typeof text.endText>) =>
      plain(text.endText(...args)),
    draftText: (...args: Parameters<typeof text.draftText>) =>
      plain(text.draftText(...args)),
  };
}

// Friday 20:37
const FRIDAY_EVENING = { weekday: 4, minute: 20 * 60 + 37 };
const WEEKNIGHTS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

describe("useScheduleText", () => {
  it("says when quiet hours start later today", () => {
    const { statusText } = scheduleText();
    expect(
      statusText(
        FRIDAY_EVENING,
        { quiet: false, changesAt: { weekday: 4, minute: 23 * 60 } },
        1,
      ),
    ).toBe("Quiet hours start at 11:00 PM");
  });

  it("says when quiet hours start tomorrow or on a later day", () => {
    const { statusText } = scheduleText();
    expect(
      statusText(
        FRIDAY_EVENING,
        { quiet: false, changesAt: { weekday: 5, minute: 8 * 60 } },
        1,
      ),
    ).toBe("Quiet hours start tomorrow at 8:00 AM");
    expect(
      statusText(
        FRIDAY_EVENING,
        { quiet: false, changesAt: { weekday: 0, minute: 23 * 60 } },
        1,
      ),
    ).toBe("Quiet hours start Monday at 11:00 PM");
  });

  it("says when pushes resume", () => {
    const { statusText } = scheduleText();
    expect(
      statusText(
        FRIDAY_EVENING,
        { quiet: true, changesAt: { weekday: 4, minute: 21 * 60 + 38 } },
        2,
      ),
    ).toBe("Pushes resume at 9:38 PM");
    expect(
      statusText(
        FRIDAY_EVENING,
        { quiet: true, changesAt: { weekday: 5, minute: 6 * 60 + 30 } },
        1,
      ),
    ).toBe("Pushes resume tomorrow at 6:30 AM");
  });

  it("summarizes a window", () => {
    const { windowText } = scheduleText();
    expect(
      windowText({
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "20:38",
        end: "21:38",
      }),
    ).toBe("Weekdays, 8:38 PM to 9:38 PM");
  });

  it("names the nights an overnight window starts and the mornings it ends", () => {
    const { windowText, endText } = scheduleText();
    const cases: [Weekday[], string, string][] = [
      [
        ["mon", "tue", "wed", "thu", "fri"],
        "Mon to Fri nights, 11:00 PM to 6:30 AM",
        "Ends Tue to Sat mornings",
      ],
      [
        ["sun", "mon", "tue", "wed", "thu"],
        "Sun to Thu nights, 11:00 PM to 6:30 AM",
        "Ends Mon to Fri mornings",
      ],
      [["sun"], "Sun nights, 11:00 PM to 6:30 AM", "Ends Mon mornings"],
      [
        ["sat", "sun"],
        "Sat, Sun nights, 11:00 PM to 6:30 AM",
        "Ends Sun, Mon mornings",
      ],
      [
        ["mon", "wed", "fri"],
        "Mon, Wed, Fri nights, 11:00 PM to 6:30 AM",
        "Ends Tue, Thu, Sat mornings",
      ],
      [
        ["fri", "sat", "sun", "mon"],
        "Fri to Mon nights, 11:00 PM to 6:30 AM",
        "Ends Sat to Tue mornings",
      ],
      [[], "Every night, 11:00 PM to 6:30 AM", "Ends next morning"],
    ];
    for (const [days, summary, ends] of cases) {
      const window = { days, start: "23:00", end: "06:30" };
      expect(windowText(window)).toBe(summary);
      expect(endText(window)).toBe(ends);
    }
  });

  it("words overnight windows that start by day or end after noon or at midnight", () => {
    const { windowText, endText } = scheduleText();
    const midnight = { days: WEEKNIGHTS, start: "22:00", end: "00:00" };
    expect(windowText(midnight)).toBe(
      "Mon to Fri nights, 10:00 PM to 12:00 AM",
    );
    expect(endText(midnight)).toBe("Ends at midnight");

    const morningStart = {
      days: ["mon"] as Weekday[],
      start: "09:00",
      end: "08:00",
    };
    expect(windowText(morningStart)).toBe("Starts Mon, 9:00 AM to 8:00 AM");
    expect(endText(morningStart)).toBe("Ends Tue mornings");

    const afternoonEnd = {
      days: ["sat"] as Weekday[],
      start: "20:00",
      end: "14:00",
    };
    expect(windowText(afternoonEnd)).toBe("Sat nights, 8:00 PM to 2:00 PM");
    expect(endText(afternoonEnd)).toBe("Ends Sun");
    expect(endText({ ...afternoonEnd, days: [] })).toBe("Ends next day");
    expect(windowText({ ...morningStart, days: [] })).toBe(
      "Every day, 9:00 AM to 8:00 AM",
    );
  });

  it("keeps same-day and full day windows on the days they name", () => {
    const { windowText, endText } = scheduleText();
    const work = {
      days: ["mon", "tue", "wed", "thu"] as Weekday[],
      start: "09:00",
      end: "17:00",
    };
    expect(windowText(work)).toBe("Mon to Thu, 9:00 AM to 5:00 PM");
    expect(endText(work)).toBeUndefined();
    const fullDay = { days: [] as Weekday[], start: "09:00", end: "09:00" };
    expect(windowText(fullDay)).toBe("Every day, 9:00 AM to 9:00 AM");
    expect(endText(fullDay)).toBeUndefined();
    expect(endText({ days: [], start: "", end: "07:00" })).toBeUndefined();
  });

  it("says what saving would change", () => {
    const { draftText } = scheduleText();
    expect(
      draftText(
        FRIDAY_EVENING,
        { quiet: true, changesAt: { weekday: 5, minute: 7 * 60 } },
        1,
        true,
      ),
    ).toBe("After saving: quiet now. Pushes resume tomorrow at 7:00 AM");
    expect(
      draftText(
        FRIDAY_EVENING,
        { quiet: false, changesAt: { weekday: 4, minute: 22 * 60 } },
        1,
        true,
      ),
    ).toBe("After saving: not quiet now. Quiet hours start at 10:00 PM");
    expect(
      draftText(FRIDAY_EVENING, { quiet: false, changesAt: null }, 0, true),
    ).toBe("After saving: no quiet hours");
    expect(
      draftText(FRIDAY_EVENING, { quiet: true, changesAt: null }, 1, false),
    ).toBe("After saving: notifications off");
  });
});
