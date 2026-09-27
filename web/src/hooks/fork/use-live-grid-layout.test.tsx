import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { AuthContext } from "@/context/auth-state";
import { useLiveGridLayout } from "./use-live-grid-layout";
import type { Layout } from "react-grid-layout";

const fixture = vi.hoisted(() => ({
  viewport: "desktop",
  store: new Map<string, unknown>(),
}));
vi.mock("./use-viewport", () => ({
  useViewport: () => ({ class: fixture.viewport }),
  getViewportClass: () => fixture.viewport,
}));
vi.mock("idb-keyval", () => ({
  get: vi.fn((key: string) => Promise.resolve(fixture.store.get(key))),
  set: vi.fn((key: string, value: unknown) => {
    fixture.store.set(key, value);
    return Promise.resolve();
  }),
  del: vi.fn((key: string) => {
    fixture.store.delete(key);
    return Promise.resolve();
  }),
}));
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
const desktop: Layout = [{ i: "front", x: 0, y: 0, w: 6, h: 4 }];
const tablet: Layout = [{ i: "front", x: 0, y: 0, w: 12, h: 8 }];
beforeEach(() => {
  fixture.viewport = "desktop";
  fixture.store.clear();
  localStorage.setItem("frigateDeviceId", "browser");
});

it("restores each viewport independently and seeds new sizes from the shared layout", async () => {
  fixture.store.set("front-draggable-layout", tablet);
  fixture.store.set("front-draggable-layout:desktop-browser", desktop);
  const { result, rerender } = renderHook(() => useLiveGridLayout("front"), {
    wrapper,
  });
  await waitFor(() => expect(result.current[2]).toBe(true));
  expect(result.current[0]).toEqual(desktop);
  fixture.viewport = "tablet";
  rerender();
  await waitFor(() => expect(result.current[2]).toBe(true));
  expect(result.current[0]).toEqual(tablet);
  act(() => result.current[1](tablet));
  expect(fixture.store.get("front-draggable-layout:tablet-browser")).toEqual(
    tablet,
  );
  expect(fixture.store.get("front-draggable-layout:desktop-browser")).toEqual(
    desktop,
  );
  fixture.viewport = "desktop";
  rerender();
  await waitFor(() => expect(result.current[2]).toBe(true));
  expect(result.current[0]).toEqual(desktop);
});

it("clears the active layout and shared seed without deleting another size", async () => {
  fixture.store.set("front-draggable-layout", desktop);
  fixture.store.set("front-draggable-layout:desktop-browser", desktop);
  fixture.store.set("front-draggable-layout:tablet-browser", tablet);
  const { result } = renderHook(() => useLiveGridLayout("front"), { wrapper });
  await waitFor(() => expect(result.current[2]).toBe(true));
  act(() => result.current[3]());
  await waitFor(() => expect(result.current[0]).toBeUndefined());
  expect(fixture.store.has("front-draggable-layout")).toBe(false);
  expect(fixture.store.get("front-draggable-layout:tablet-browser")).toEqual(
    tablet,
  );
});
