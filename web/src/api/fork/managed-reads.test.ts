import axios, { CanceledError } from "axios";
import { describe, expect, it, vi } from "vitest";
import { ManagedReads, managedReadsFor } from "./managed-reads";
describe("managed page reads", () => {
  it("deduplicates concurrent consumers and aborts only after the last leaves", async () => {
    let signal: AbortSignal | undefined;
    const get = vi.spyOn(axios, "get").mockImplementation((_url, options) => {
      signal = options?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new CanceledError()));
      });
    });
    const pool = new ManagedReads();
    const releaseA = pool.retain("exports");
    const releaseB = pool.retain("exports");
    const a = pool.read("exports");
    const b = pool.read("exports");
    expect(a).toBe(b);
    expect(get).toHaveBeenCalledTimes(1);
    const rejected = expect(a).rejects.toBeInstanceOf(CanceledError);
    releaseA();
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
    releaseB();
    await rejected;
    expect(signal?.aborted).toBe(true);
  });
  it("preserves a read when StrictMode immediately reacquires its key", async () => {
    let finish!: (value: { data: string[] }) => void;
    vi.spyOn(axios, "get").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pool = new ManagedReads();
    const release = pool.retain("cases");
    const promise = pool.read("cases");
    release();
    const releaseAgain = pool.retain("cases");
    await Promise.resolve();
    finish({ data: ["case"] });
    await expect(promise).resolves.toEqual(["case"]);
    releaseAgain();
  });
  it("keeps filters separate, passes cancellation and timeout, and permits retry", async () => {
    const get = vi
      .spyOn(axios, "get")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ data: [] });
    const pool = new ManagedReads();
    await expect(pool.read(["exports", { cameras: "front" }])).rejects.toThrow(
      "offline",
    );
    await pool.read(["exports", { cameras: "back" }]);
    await pool.read(["exports", { cameras: "front" }]);
    expect(get).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenLastCalledWith(
      "exports",
      expect.objectContaining({
        params: { cameras: "front" },
        timeout: 15000,
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  });
  it("expires speculative freshness and isolates SWR providers", () => {
    const cache = new Map();
    const pool = managedReadsFor(cache);
    expect(managedReadsFor(cache)).toBe(pool);
    expect(managedReadsFor(new Map())).not.toBe(pool);
    vi.spyOn(Date, "now").mockReturnValue(100);
    pool.warm("cases");
    expect(pool.isWarm("cases")).toBe(true);
    pool.forgetWarm("cases");
    expect(pool.isWarm("cases")).toBe(false);
    pool.warm("cases");
    vi.spyOn(Date, "now").mockReturnValue(6000);
    expect(pool.isWarm("cases")).toBe(false);
  });
});
