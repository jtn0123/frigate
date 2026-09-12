import { memo, useContext, type ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../auth-state";
import { AuthProvider } from "../auth-context";
import {
  DetailStreamProvider,
  useDetailStream,
} from "../detail-stream-context";
import { LanguageProvider, useLanguage } from "../language-provider";
import { ThemeProvider, useTheme } from "../theme-provider";
import {
  StreamingSettingsProvider,
  useStreamingSettings,
} from "../streaming-settings-provider";
import { StatusBarMessagesContext } from "../statusbar-context";
import { StatusBarMessagesProvider } from "../statusbar-provider";

const mocks = vi.hoisted(() => ({
  profile: { data: undefined, error: undefined },
  persisted: {},
  persist: vi.fn(),
  remove: vi.fn(),
  get: vi.fn().mockResolvedValue({}),
}));
vi.mock("swr", () => ({ default: () => mocks.profile }));
vi.mock("axios", () => ({
  default: { get: mocks.get, isAxiosError: () => false },
}));
vi.mock("@/hooks/use-user-persistence", () => ({
  useUserPersistence: () => [
    mocks.persisted,
    mocks.persist,
    true,
    mocks.remove,
  ],
}));
vi.mock("i18next", () => ({
  default: { language: "en", changeLanguage: vi.fn() },
}));

function observe<T>(useValue: () => T, wrap: (child: ReactNode) => ReactNode) {
  const renders = vi.fn();
  let latest: T;
  const Consumer = memo(function Consumer() {
    latest = useValue();
    renders();
    return null;
  });
  const child = <Consumer />;
  const view = render(wrap(child));
  return {
    value: () => latest!,
    rerender: (nextWrap = wrap) => view.rerender(nextWrap(child)),
    renders,
  };
}

beforeEach(() => {
  mocks.get.mockResolvedValue({});
});

describe("context propagation", () => {
  it("auth skips unrelated renders and still publishes login and logout", () => {
    const result = observe(
      () => useContext(AuthContext),
      (child) => <AuthProvider>{child}</AuthProvider>,
    );
    const before = result.value();
    const renders = result.renders.mock.calls.length;
    result.rerender();
    expect(result.value()).toBe(before);
    expect(result.renders).toHaveBeenCalledTimes(renders);
    act(() => result.value().login({ username: "viewer", role: "viewer" }));
    expect(result.value().auth.user?.username).toBe("viewer");
    expect(result.value().login).toBe(before.login);
    act(() => result.value().logout());
    expect(result.value().auth.user).toBeNull();
    expect(mocks.get).toHaveBeenCalledWith("/logout", {
      withCredentials: true,
    });
  });

  it("detail stream skips unrelated renders and updates selection and time", () => {
    const wrap = (child: ReactNode) => (
      <DetailStreamProvider isDetailMode camera="front" currentTime={1}>
        {child}
      </DetailStreamProvider>
    );
    const result = observe(useDetailStream, wrap);
    const before = result.value();
    const renders = result.renders.mock.calls.length;
    result.rerender();
    expect(result.value()).toBe(before);
    expect(result.renders).toHaveBeenCalledTimes(renders);
    act(() => result.value().toggleObjectSelection("object-1"));
    expect(result.value().selectedObjectIds).toEqual(["object-1"]);
    act(() => result.value().toggleObjectSelection("object-1"));
    expect(result.value().selectedObjectIds).toEqual([]);
    result.rerender((child) => (
      <DetailStreamProvider isDetailMode camera="front" currentTime={2}>
        {child}
      </DetailStreamProvider>
    ));
    expect(result.value().currentTime).toBe(2);
  });

  it("language skips unrelated renders and refreshes its storage-key callback", () => {
    const result = observe(useLanguage, (child) => (
      <LanguageProvider storageKey="first">{child}</LanguageProvider>
    ));
    const before = result.value();
    const renders = result.renders.mock.calls.length;
    result.rerender();
    expect(result.value()).toBe(before);
    expect(result.renders).toHaveBeenCalledTimes(renders);
    result.rerender((child) => (
      <LanguageProvider storageKey="second">{child}</LanguageProvider>
    ));
    expect(result.value().setLanguage).not.toBe(before.setLanguage);
    expect(result.value().language).toBe(before.language);
  });

  it("theme skips unrelated renders and persists the current theme and color", () => {
    const result = observe(useTheme, (child) => (
      <ThemeProvider defaultTheme="light">{child}</ThemeProvider>
    ));
    const before = result.value();
    const renders = result.renders.mock.calls.length;
    result.rerender();
    expect(result.value()).toBe(before);
    expect(result.renders).toHaveBeenCalledTimes(renders);
    act(() => result.value().setTheme("dark"));
    act(() => result.value().setColorScheme("theme-blue"));
    expect(result.value().theme).toBe("dark");
    expect(result.value().colorScheme).toBe("theme-blue");
    expect(JSON.parse(localStorage.getItem("frigate-ui-theme")!)).toEqual({
      theme: "dark",
      colorScheme: "theme-blue",
    });
  });

  it("streaming settings skip unrelated renders and persist changed groups", () => {
    const result = observe(useStreamingSettings, (child) => (
      <StreamingSettingsProvider>{child}</StreamingSettingsProvider>
    ));
    const before = result.value();
    const renders = result.renders.mock.calls.length;
    result.rerender();
    expect(result.value()).toBe(before);
    expect(result.renders).toHaveBeenCalledTimes(renders);
    act(() => result.value().setAllGroupsStreamingSettings({ front: {} }));
    expect(result.value().allGroupsStreamingSettings).toEqual({ front: {} });
    expect(mocks.persist).toHaveBeenLastCalledWith({ front: {} });
  });

  it("status messages skip unrelated renders and still add and remove messages", () => {
    const result = observe(
      () => useContext(StatusBarMessagesContext)!,
      (child) => <StatusBarMessagesProvider>{child}</StatusBarMessagesProvider>,
    );
    const before = result.value();
    const renders = result.renders.mock.calls.length;
    result.rerender();
    expect(result.value()).toBe(before);
    expect(result.renders).toHaveBeenCalledTimes(renders);
    act(() => {
      result
        .value()
        .addMessage("front", "Camera unavailable", undefined, "id-1");
    });
    expect(result.value().messages.front[0].text).toBe("Camera unavailable");
    act(() => result.value().removeMessage("front", "id-1"));
    expect(result.value().messages.front).toEqual([]);
    act(() => result.value().clearMessages("front"));
    expect(result.value().messages.front).toBeUndefined();
  });
});
