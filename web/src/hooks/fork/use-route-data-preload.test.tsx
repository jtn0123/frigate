import { act, renderHook, waitFor } from "@testing-library/react";
import axios from "axios";
import { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext, AuthState } from "@/context/auth-state";
import { useRouteDataPreload } from "./use-route-data-preload";
import { useManagedRead } from "./use-managed-read";

const ready: AuthState = {
  isLoading: false,
  isAuthenticated: true,
  user: { username: "test", role: "admin" },
  allowedCameras: [],
};
function wrapper(auth = ready) {
  const cache = new Map();
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return (
      <AuthContext.Provider value={{ auth, login: () => {}, logout: () => {} }}>
        <SWRConfig value={{ provider: () => cache }}>{children}</SWRConfig>
      </AuthContext.Provider>
    );
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("metadata intent preloading", () => {
  it("prefetches only cases once, then serves the same data to the page", async () => {
    const get = vi
      .spyOn(axios, "get")
      .mockResolvedValue({ data: [{ id: "case" }] });
    const Wrapper = wrapper();
    const intent = renderHook(useRouteDataPreload, { wrapper: Wrapper });
    await act(async () => {
      intent.result.current("/system");
      intent.result.current("/export");
      intent.result.current("/export");
    });
    const page = renderHook(() => useManagedRead<{ id: string }[]>("cases"), {
      wrapper: Wrapper,
    });
    await waitFor(() =>
      expect(page.result.current.data).toEqual([{ id: "case" }]),
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("cases", expect.anything());
  });
  it.each([
    { ...ready, isLoading: true },
    { ...ready, user: null },
  ])("does not speculate before authorization is known", (auth) => {
    const get = vi.spyOn(axios, "get");
    const { result } = renderHook(useRouteDataPreload, {
      wrapper: wrapper(auth),
    });
    act(() => result.current("/export"));
    expect(get).not.toHaveBeenCalled();
  });
  it("respects data saver and retries a failed speculative request on visit", async () => {
    const get = vi
      .spyOn(axios, "get")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ data: [] });
    const Wrapper = wrapper();
    const intent = renderHook(useRouteDataPreload, { wrapper: Wrapper });
    vi.stubGlobal("navigator", {
      onLine: true,
      connection: { saveData: true },
    });
    act(() => intent.result.current("/export"));
    expect(get).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", { onLine: true });
    await act(async () => {
      intent.result.current("/export");
    });
    const page = renderHook(() => useManagedRead<unknown[]>("cases"), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(page.result.current.data).toEqual([]));
    expect(get).toHaveBeenCalledTimes(2);
  });
});
