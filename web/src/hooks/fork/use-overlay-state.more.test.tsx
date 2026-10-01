import { act, renderHook } from "@testing-library/react";
import { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, AuthState } from "@/context/auth-state";
import {
  useHashState,
  useOverlayState,
  usePersistedOverlayState,
  useSearchEffect,
  useUserPersistedOverlayState,
} from "@/hooks/use-overlay-state";

const fx = vi.hoisted(() => ({
  persisted: undefined as string | undefined,
  userPersisted: undefined as string | undefined,
  setPersisted: vi.fn(),
  deletePersisted: vi.fn(),
  setUserPersisted: vi.fn(),
  deleteUserPersisted: vi.fn(),
}));

vi.mock("@/hooks/use-persistence", () => ({
  usePersistence: () => [
    fx.persisted,
    fx.setPersisted,
    true,
    fx.deletePersisted,
  ],
}));
vi.mock("@/hooks/use-user-persistence", () => ({
  useUserPersistence: () => [
    fx.userPersisted,
    fx.setUserPersisted,
    true,
    fx.deleteUserPersisted,
  ],
}));

type Entry = {
  pathname: string;
  search?: string;
  hash?: string;
  state?: unknown;
};

function wrapper(entry: Entry, auth?: Partial<AuthState>) {
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    const router = (
      <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
    );
    if (!auth) return router;
    return (
      <AuthContext.Provider
        value={{
          auth: {
            user: { username: "bob", role: "admin" },
            allowedCameras: [],
            isLoading: false,
            isAuthenticated: true,
            ...auth,
          },
          login: () => {},
          logout: () => {},
        }}
      >
        {router}
      </AuthContext.Provider>
    );
  };
}

beforeEach(() => {
  fx.persisted = undefined;
  fx.userPersisted = undefined;
});

describe("useOverlayState", () => {
  it("falls back to the default and can drop the search", async () => {
    const { result } = renderHook(
      () => {
        const [value, setValue] = useOverlayState<string>("tab", "info", false);
        return { value, setValue, location: useLocation() };
      },
      { wrapper: wrapper({ pathname: "/explore", search: "?q=car" }) },
    );
    expect(result.current.value).toBe("info");

    await act(async () => result.current.setValue("info"));
    expect(result.current.location.search).toBe("");
    expect(result.current.value).toBe("info");
    expect(result.current.location.state).toEqual({ tab: "info" });

    const key = result.current.location.key;
    await act(async () => result.current.setValue("info"));
    expect(result.current.location.key).toBe(key);
  });
});

describe("usePersistedOverlayState", () => {
  it("prefers location state, then the persisted value, then the default", async () => {
    fx.persisted = "saved";
    const { result } = renderHook(
      () => {
        const [value, setValue, loaded, remove] =
          usePersistedOverlayState<string>("view", "grid");
        return { value, setValue, loaded, remove, location: useLocation() };
      },
      { wrapper: wrapper({ pathname: "/live", search: "?x=1" }) },
    );
    expect(result.current.value).toBe("saved");
    expect(result.current.loaded).toBe(true);
    expect(result.current.remove).toBe(fx.deletePersisted);

    await act(async () => result.current.setValue("list"));
    expect(fx.setPersisted).toHaveBeenCalledWith("list");
    expect(result.current.value).toBe("list");
    // the search is not preserved for persisted overlays
    expect(result.current.location.search).toBe("");

    fx.setPersisted.mockClear();
    await act(async () => result.current.setValue("list"));
    expect(fx.setPersisted).not.toHaveBeenCalled();
  });

  it("uses the default when nothing is stored", () => {
    const { result } = renderHook(
      () => usePersistedOverlayState<string>("view", "grid"),
      { wrapper: wrapper({ pathname: "/live" }) },
    );
    expect(result.current[0]).toBe("grid");
  });
});

describe("useUserPersistedOverlayState", () => {
  it("returns nothing until auth has loaded", () => {
    fx.userPersisted = "saved";
    const { result } = renderHook(
      () => useUserPersistedOverlayState<string>("view", "grid"),
      { wrapper: wrapper({ pathname: "/live" }, { isLoading: true }) },
    );
    expect(result.current[0]).toBeUndefined();
    expect(result.current[2]).toBe(false);
    expect(result.current[3]).toBe(fx.deleteUserPersisted);
  });

  it("reads and writes the user-scoped value", async () => {
    fx.userPersisted = "saved";
    const { result } = renderHook(
      () => {
        const [value, setValue, loaded] = useUserPersistedOverlayState<string>(
          "view",
          "grid",
        );
        return { value, setValue, loaded, location: useLocation() };
      },
      {
        wrapper: wrapper(
          { pathname: "/live", state: { other: 1 } },
          { isLoading: false },
        ),
      },
    );
    expect(result.current.value).toBe("saved");
    expect(result.current.loaded).toBe(true);

    await act(async () => result.current.setValue("list", true));
    expect(fx.setUserPersisted).toHaveBeenCalledWith("list");
    expect(result.current.location.state).toEqual({ other: 1, view: "list" });

    fx.setUserPersisted.mockClear();
    await act(async () => result.current.setValue("list"));
    expect(fx.setUserPersisted).not.toHaveBeenCalled();
  });

  it("uses the default when nothing is stored", () => {
    const { result } = renderHook(
      () => useUserPersistedOverlayState<string>("view", "grid"),
      { wrapper: wrapper({ pathname: "/live" }, {}) },
    );
    expect(result.current[0]).toBe("grid");
  });
});

describe("useHashState", () => {
  it("sets and clears the hash while keeping search and state", async () => {
    const { result } = renderHook(
      () => {
        const [hash, setHash] = useHashState<string>();
        return { hash, setHash, location: useLocation() };
      },
      {
        wrapper: wrapper({
          pathname: "/settings",
          search: "?camera=front",
          state: { keep: true },
        }),
      },
    );
    expect(result.current.hash).toBe("");

    await act(async () => result.current.setHash("motion"));
    expect(result.current.hash).toBe("motion");
    expect(result.current.location.search).toBe("?camera=front");
    expect(result.current.location.state).toEqual({ keep: true });

    await act(async () => result.current.setHash(""));
    expect(result.current.hash).toBe("");
    expect(result.current.location.hash).toBe("");
    expect(result.current.location.state).toEqual({ keep: true });
  });
});

describe("useSearchEffect", () => {
  it("strips a handled param once and keeps location state", async () => {
    const callback = vi.fn(() => true);
    const { result } = renderHook(
      () => {
        useSearchEffect("id", callback);
        return useLocation();
      },
      {
        wrapper: wrapper({
          pathname: "/explore",
          search: "?id=a%20b",
          hash: "#top",
          state: { open: true },
        }),
      },
    );
    await act(async () => {});
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("a b");
    expect(result.current.search).toBe("");
    expect(result.current.hash).toBe("#top");
    expect(result.current.state).toEqual({ open: true });
  });

  it("keeps the param when the callback declines it", async () => {
    const callback = vi.fn(() => false);
    const { result } = renderHook(
      () => {
        useSearchEffect("id", callback);
        return useLocation();
      },
      { wrapper: wrapper({ pathname: "/explore", search: "?id=1" }) },
    );
    await act(async () => {});
    expect(callback).toHaveBeenCalledWith("1");
    expect(result.current.search).toBe("?id=1");
  });

  it("does nothing without the param", async () => {
    const callback = vi.fn(() => true);
    renderHook(() => useSearchEffect("id", callback), {
      wrapper: wrapper({ pathname: "/explore" }),
    });
    await act(async () => {});
    expect(callback).not.toHaveBeenCalled();
  });
});
