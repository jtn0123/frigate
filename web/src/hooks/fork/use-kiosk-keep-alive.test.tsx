import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEP_ALIVE_MS } from "@/lib/fork/kiosk";
import { useKioskKeepAlive } from "./use-kiosk-keep-alive";

const fetcher = vi.fn((key: string) => Promise.resolve({ key }));

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        fetcher,
      }}
    >
      {children}
    </SWRConfig>
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetcher.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useKioskKeepAlive", () => {
  it("reads the profile once per interval while the display is open", async () => {
    const { unmount } = renderHook(() => useKioskKeepAlive(KEEP_ALIVE_MS), {
      wrapper,
    });
    await advance(KEEP_ALIVE_MS - 1);
    expect(fetcher).not.toHaveBeenCalled();
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenLastCalledWith("/profile");

    // a day of streaming with no other requests
    await advance(24 * 60 * 60 * 1000 - KEEP_ALIVE_MS);
    expect(fetcher).toHaveBeenCalledTimes(144);

    unmount();
    await advance(KEEP_ALIVE_MS * 3);
    expect(fetcher).toHaveBeenCalledTimes(144);
  });

  it("keeps reading while the page is hidden", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    renderHook(() => useKioskKeepAlive(KEEP_ALIVE_MS), { wrapper });
    await advance(KEEP_ALIVE_MS * 2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a session to keep", async () => {
    renderHook(() => useKioskKeepAlive(0), { wrapper });
    await advance(KEEP_ALIVE_MS * 3);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
