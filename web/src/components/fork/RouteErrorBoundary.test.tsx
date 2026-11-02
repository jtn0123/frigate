import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RouteErrorBoundary from "./RouteErrorBoundary";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));
vi.mock("@/fork/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/fork/flags")>()),
  isForkEnabled: () => true,
}));

const state = vi.hoisted(() => ({ broken: true, mounts: 0 }));

function Thrower() {
  if (state.broken) {
    throw new Error("render failed");
  }
  return <div data-testid="healthy" />;
}

function MountCounter() {
  useEffect(() => {
    state.mounts += 1;
  }, []);
  return null;
}

let navigateTo: (path: string) => void = () => undefined;

function NavigateCapture() {
  const navigate = useNavigate();
  navigateTo = (path) => void navigate(path);
  return null;
}

function renderBoundary(cache = new Map()) {
  return render(
    <SWRConfig value={{ provider: () => cache }}>
      <MemoryRouter initialEntries={["/export"]}>
        <NavigateCapture />
        <RouteErrorBoundary>
          <MountCounter />
          <Thrower />
        </RouteErrorBoundary>
      </MemoryRouter>
    </SWRConfig>,
  );
}

describe("RouteErrorBoundary", () => {
  beforeEach(() => {
    state.broken = true;
    state.mounts = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears the error on a route change without a remount", () => {
    renderBoundary();
    expect(screen.getByTestId("fork-error-boundary")).toBeInTheDocument();

    state.broken = false;
    act(() => navigateTo("/review"));
    expect(screen.queryByTestId("fork-error-boundary")).toBeNull();
    expect(screen.getByTestId("healthy")).toBeInTheDocument();

    const mounts = state.mounts;
    act(() => navigateTo("/explore"));
    expect(state.mounts).toBe(mounts);
  });

  it("puts the cached version first in the copied report", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const cache = new Map([
      ["stats", { data: { service: { version: "0.17.0-abc" } } }],
    ]);
    renderBoundary(cache);

    await act(async () => {
      fireEvent.click(screen.getByText("errorBoundary.copyDetails"));
    });
    const report = String(writeText.mock.calls.at(0)?.at(0));
    expect(report.split("\n").slice(0, 2)).toEqual([
      "Frigate UI error report",
      "Version: 0.17.0-abc",
    ]);
    expect(report).toContain("Message: render failed");
  });

  it("reports an unknown version when no stats are cached", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderBoundary();

    await act(async () => {
      fireEvent.click(screen.getByText("errorBoundary.copyDetails"));
    });
    expect(String(writeText.mock.calls.at(0)?.at(0))).toContain(
      "Version: unknown",
    );
  });
});
