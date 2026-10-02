import { renderHook, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { de, enUS, faIR, nb, pt, zhCN, zhHK, zhTW } from "date-fns/locale";
import { useDateLocale } from "@/hooks/use-date-locale";

const i18n = vi.hoisted(() => ({ language: "en" }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n }),
}));

// Every date-fns locale module the hook can import on demand.
const LOCALE_LOADERS = [
  () => import("date-fns/locale/ar"),
  () => import("date-fns/locale/be"),
  () => import("date-fns/locale/bs"),
  () => import("date-fns/locale/ca"),
  () => import("date-fns/locale/cs"),
  () => import("date-fns/locale/da"),
  () => import("date-fns/locale/de"),
  () => import("date-fns/locale/el"),
  () => import("date-fns/locale/es"),
  () => import("date-fns/locale/fa-IR"),
  () => import("date-fns/locale/fi"),
  () => import("date-fns/locale/fr"),
  () => import("date-fns/locale/he"),
  () => import("date-fns/locale/hi"),
  () => import("date-fns/locale/hr"),
  () => import("date-fns/locale/hu"),
  () => import("date-fns/locale/it"),
  () => import("date-fns/locale/ja"),
  () => import("date-fns/locale/ko"),
  () => import("date-fns/locale/lt"),
  () => import("date-fns/locale/nb"),
  () => import("date-fns/locale/nl"),
  () => import("date-fns/locale/pl"),
  () => import("date-fns/locale/pt"),
  () => import("date-fns/locale/ro"),
  () => import("date-fns/locale/ru"),
  () => import("date-fns/locale/sk"),
  () => import("date-fns/locale/sl"),
  () => import("date-fns/locale/sv"),
  () => import("date-fns/locale/th"),
  () => import("date-fns/locale/tr"),
  () => import("date-fns/locale/uk"),
  () => import("date-fns/locale/vi"),
  () => import("date-fns/locale/zh-CN"),
  () => import("date-fns/locale/zh-HK"),
  () => import("date-fns/locale/zh-TW"),
];

// The hook loads each locale with a dynamic import, and the first import of a
// module goes through the vitest runner's fetch round trip to the main
// process. Under a loaded full run that round trip can outlast waitFor's 1 s
// default, which made this file flaky. Importing every locale once here, under
// the hook timeout, leaves the hook's imports as runner cache hits, so each
// assertion only waits on promises that are already settled.
beforeAll(async () => {
  await Promise.all(LOCALE_LOADERS.map((load) => load()));
});

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
