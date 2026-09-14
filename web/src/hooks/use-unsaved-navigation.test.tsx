import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnsavedNavigation } from "./use-unsaved-navigation";

function Editor({ dirty }: Readonly<{ dirty: boolean }>) {
  useUnsavedNavigation(dirty);
  return <div>Editor</div>;
}
afterEach(() => vi.restoreAllMocks());

describe("unsaved navigation", () => {
  it("keeps edits on cancel, allows same-page changes, and leaves on confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const router = createMemoryRouter(
      [
        { path: "/settings", element: <Editor dirty /> },
        { path: "/system", element: <div>System</div> },
      ],
      { initialEntries: ["/settings"] },
    );
    render(<RouterProvider router={router} />);
    await act(() => router.navigate("/system"));
    expect(router.state.location.pathname).toBe("/settings");
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(() => router.navigate("/settings?page=camera"));
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    await act(() => router.navigate("/system"));
    expect(router.state.location.pathname).toBe("/system");
    router.dispose();
  });
  it("blocks tab close only while dirty and removes the handler on unmount", () => {
    const { unmount } = render(
      <RouterProvider
        router={createMemoryRouter([{ path: "/", element: <Editor dirty /> }])}
      />,
    );
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    unmount();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });
  it("allows navigation from a clean editor", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const router = createMemoryRouter([
      { path: "/", element: <Editor dirty={false} /> },
      { path: "/system", element: <div>System</div> },
    ]);
    render(<RouterProvider router={router} />);
    await act(() => router.navigate("/system"));
    expect(router.state.location.pathname).toBe("/system");
    expect(confirm).not.toHaveBeenCalled();
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
