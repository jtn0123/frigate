import { renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOOTAGE_RESULT_LIMIT,
  MIN_FOOTAGE_QUERY,
  useFootageSearch,
} from "./use-footage-search";

type Key = [string, Record<string, unknown>] | string | null;

function wrapper(fetcher: (key: Key) => Promise<unknown>) {
  const cache = new Map();
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return (
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
          shouldRetryOnError: false,
          fetcher,
        }}
      >
        {children}
      </SWRConfig>
    );
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useFootageSearch", () => {
  it("does not search while semantic search is off", async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() => useFootageSearch("red car", false), {
      wrapper: wrapper(fetcher),
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
    expect(result.current.query).toBe("");
  });

  it("ignores a query shorter than the minimum", async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const short = "a".repeat(MIN_FOOTAGE_QUERY - 1);
    renderHook(() => useFootageSearch(short, true), {
      wrapper: wrapper(fetcher),
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks for the trimmed query once the keystrokes settle", async () => {
    const keys: Key[] = [];
    const fetcher = vi.fn((key: Key) => {
      keys.push(key);
      return Promise.resolve([{ id: "1" }]);
    });
    const { result } = renderHook(() => useFootageSearch("  red car  ", true), {
      wrapper: wrapper(fetcher),
    });

    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(keys).toEqual([
      [
        "events/search",
        {
          query: "red car",
          limit: FOOTAGE_RESULT_LIMIT,
          include_thumbnails: 0,
        },
      ],
    ]);
    expect(result.current.query).toBe("red car");
  });

  it("makes one request for a word typed a letter at a time", async () => {
    const keys: Key[] = [];
    const fetcher = vi.fn((key: Key) => {
      keys.push(key);
      return Promise.resolve([]);
    });
    // the palette mounts with an empty box, so the first letter is debounced
    // like every one after it
    const { rerender, result } = renderHook(
      ({ query }) => useFootageSearch(query, true),
      { initialProps: { query: "" }, wrapper: wrapper(fetcher) },
    );

    rerender({ query: "ca" });
    rerender({ query: "car" });
    rerender({ query: "cars" });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(keys).toEqual([
      [
        "events/search",
        { query: "cars", limit: FOOTAGE_RESULT_LIMIT, include_thumbnails: 0 },
      ],
    ]);
    expect(result.current.query).toBe("cars");
  });
});
