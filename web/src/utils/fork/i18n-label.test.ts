import { expect, it, vi } from "vitest";
import { getTranslatedLabel } from "@/utils/i18n";

vi.mock("i18next", () => {
  const i18n = { use: () => i18n, init: () => Promise.resolve() };
  return {
    default: i18n,
    t: (key: string, options: { ns: string }) => `${options.ns}:${key}`,
  };
});

it.each([
  ["Fire Alarm", "object", "objects:fire_alarm"],
  ["  -dog- ", "object", "objects:dog"],
  ["_baby's  cry_", "audio", "audio:baby_s_cry"],
  ["--", "object", "objects:"],
] as const)("normalizes %j into a %s key", (label, type, expected) => {
  expect(getTranslatedLabel(label, type)).toBe(expected);
});
