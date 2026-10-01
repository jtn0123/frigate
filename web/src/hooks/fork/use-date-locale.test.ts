import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { de, enUS, faIR, nb, pt, zhCN, zhHK, zhTW } from "date-fns/locale";
import { useDateLocale } from "@/hooks/use-date-locale";

const i18n = vi.hoisted(() => ({ language: "en" }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n }),
}));

beforeEach(() => {
  i18n.language = "en";
});

describe("useDateLocale", () => {
  it("uses enUS for English", () => {
    const { result } = renderHook(() => useDateLocale());
    expect(result.current).toBe(enUS);
  });

  it.each([
    ["de", de],
    ["zh-CN", zhCN],
    ["pt-BR", pt],
    ["nb-NO", nb],
    ["fa", faIR],
    ["yue-Hant", zhHK],
    ["zh-Hant", zhTW],
  ])("loads the %s locale", async (language, expected) => {
    i18n.language = language;
    const { result } = renderHook(() => useDateLocale());
    await waitFor(() => expect(result.current.code).toBe(expected.code));
  });

  it.each([
    "es",
    "hi",
    "fr",
    "ar",
    "pt",
    "ru",
    "ja",
    "tr",
    "it",
    "nl",
    "sv",
    "cs",
    "ko",
    "vi",
    "pl",
    "uk",
    "be",
    "he",
    "el",
    "ro",
    "hu",
    "fi",
    "da",
    "sk",
    "lt",
    "th",
    "ca",
    "hr",
    "bs",
    "sl",
  ])("loads a non-English locale for %s", async (language) => {
    i18n.language = language;
    const { result } = renderHook(() => useDateLocale());
    await waitFor(() => expect(result.current).not.toBe(enUS));
    expect(result.current.code.split("-")[0]).toBe(language);
  });

  it("falls back to enUS for unknown languages", async () => {
    i18n.language = "xx";
    const { result } = renderHook(() => useDateLocale());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBe(enUS);
  });

  it("switches back to enUS when the language returns to English", async () => {
    i18n.language = "de";
    const { result, rerender } = renderHook(() => useDateLocale());
    await waitFor(() => expect(result.current.code).toBe("de"));
    i18n.language = "en";
    rerender();
    await waitFor(() => expect(result.current).toBe(enUS));
  });
});
