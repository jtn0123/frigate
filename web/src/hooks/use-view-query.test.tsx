import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewQuery } from "./use-view-query";
import { useHashState } from "./use-overlay-state";

function View() {
  const [params, update] = useViewQuery();
  const [, setHash] = useHashState();
  return (
    <>
      <output>{params.get("model") ?? "all"}</output>
      <button onClick={() => update({ model: "audio:medium" })}>Choose</button>
      <button onClick={() => update({ model: null })}>Clear</button>
      <button onClick={() => setHash("health")}>Health</button>
    </>
  );
}

describe("shareable view state", () => {
  it("preserves unrelated query, hash, and overlay state through Back and Forward", async () => {
    const router = createMemoryRouter(
      [{ path: "/system", element: <View /> }],
      {
        initialEntries: [
          {
            pathname: "/system",
            search: "?range=15",
            hash: "#models",
            state: { overlay: 123 },
          },
        ],
      },
    );
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByText("Choose"));
    await waitFor(() =>
      expect(router.state.location.search).toContain("model=audio%3Amedium"),
    );
    expect(router.state.location.hash).toBe("#models");
    expect(router.state.location.state).toEqual({ overlay: 123 });
    fireEvent.click(screen.getByText("Health"));
    await waitFor(() => expect(router.state.location.hash).toBe("#health"));
    expect(router.state.location.search).toContain("range=15");
    expect(router.state.location.search).toContain("model=audio%3Amedium");
    await act(() => router.navigate(-1));
    expect(router.state.location.hash).toBe("#models");
    await act(() => router.navigate(-1));
    expect(screen.getByRole("status").textContent).toBe("all");
    await act(() => router.navigate(1));
    expect(screen.getByRole("status").textContent).toBe("audio:medium");
    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(router.state.location.search).toBe("?range=15"));
    router.dispose();
  });
});

// Node's Request rejects jsdom AbortSignals. These navigation-only tests have
// no loaders or network I/O; request cancellation requires browser validation.
const NativeRequest = Request;
beforeEach(() => {
  vi.stubGlobal(
    "Request",
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, { ...init, signal: undefined });
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
