import { act, renderHook, waitFor } from "@testing-library/react";
import axios, { CanceledError } from "axios";
import { ReactNode } from "react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";
import { useManagedRead } from "./use-managed-read";

function setup() {
  const cache = new Map();
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return (
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
          shouldRetryOnError: false,
        }}
      >
        {children}
      </SWRConfig>
    );
  };
}

describe("managed SWR ownership", () => {
  it("cancels an old filter without displaying its response over the new selection", async () => {
    const signals: AbortSignal[] = [];
    const finish: ((value: { data: string[] }) => void)[] = [];
    vi.spyOn(axios, "get").mockImplementation((_url, options) => {
      const signal = options?.signal as AbortSignal;
      signals.push(signal);
      return new Promise((resolve, reject) => {
        finish.push(resolve);
        signal.addEventListener("abort", () => reject(new CanceledError()));
      });
    });
    const { result, rerender, unmount } = renderHook(
      ({ camera }) => {
        const { data, error } = useManagedRead<string[]>([
          "exports",
          { cameras: camera },
        ]);
        return { data, error };
      },
      { initialProps: { camera: "front" }, wrapper: setup() },
    );
    await waitFor(() => expect(signals).toHaveLength(1));
    rerender({ camera: "back" });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await act(async () => {
      finish[1]?.({ data: ["back"] });
    });
    await waitFor(() =>
      expect({
        data: result.current.data,
        error: result.current.error,
        signals: signals.map((s) => s.aborted),
        calls: vi
          .mocked(axios.get)
          .mock.calls.map((c) => c[1]?.params as unknown),
      }).toEqual({
        data: ["back"],
        error: undefined,
        signals: [true, false],
        calls: [{ cameras: "front" }, { cameras: "back" }],
      }),
    );
    await act(async () => {
      finish[0]?.({ data: ["front"] });
    });
    expect(result.current.data).toEqual(["back"]);
    expect(result.current.error).toBeUndefined();
    unmount();
  });
});
