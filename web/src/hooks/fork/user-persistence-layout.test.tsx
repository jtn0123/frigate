import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { AuthContext } from "@/context/auth-state";
import { useUserPersistence } from "@/hooks/use-user-persistence";
import { get } from "idb-keyval";

vi.mock("idb-keyval", () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <AuthContext.Provider
      value={{
        auth: {
          user: null,
          allowedCameras: [],
          isLoading: false,
          isAuthenticated: false,
        },
        login: vi.fn(),
        logout: vi.fn(),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
beforeEach(() => vi.mocked(get).mockReset());

it("ignores a late layout read after switching viewport keys", async () => {
  let resolveDesktop!: (value: string) => void;
  vi.mocked(get).mockImplementation((key) =>
    key === "desktop"
      ? new Promise((resolve) => {
          resolveDesktop = resolve;
        })
      : Promise.resolve("tablet-layout"),
  );
  const { result, rerender } = renderHook(
    ({ name }) => useUserPersistence<string>(name),
    { initialProps: { name: "desktop" }, wrapper },
  );
  rerender({ name: "tablet" });
  await waitFor(() => expect(result.current[0]).toBe("tablet-layout"));
  await act(async () => {
    resolveDesktop("old-desktop-layout");
  });
  expect(result.current[0]).toBe("tablet-layout");
  expect(result.current[2]).toBe(true);
});
