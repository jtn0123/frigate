import axios from "axios";
import { unstable_serialize } from "swr";

export type ManagedKey = string | [string, Record<string, unknown>];
type Flight = { controller: AbortController; promise: Promise<unknown> };

/** Coordinate only opted-in reads. SWR remains the response-cache owner. */
export class ManagedReads {
  private readonly flights = new Map<string, Flight>();
  private readonly owners = new Map<string, number>();
  private readonly warmed = new Map<string, number>();

  retain(key: ManagedKey) {
    const id = unstable_serialize(key);
    this.owners.set(id, (this.owners.get(id) ?? 0) + 1);
    return () => {
      const remaining = (this.owners.get(id) ?? 1) - 1;
      if (remaining) this.owners.set(id, remaining);
      else this.owners.delete(id);
      // StrictMode and another consumer may acquire the same key this turn.
      queueMicrotask(() => {
        if (!this.owners.has(id)) {
          this.flights.get(id)?.controller.abort();
          this.flights.delete(id);
        }
      });
    };
  }

  isWarm(key: ManagedKey) {
    const id = unstable_serialize(key);
    const until = this.warmed.get(id) ?? 0;
    if (until <= Date.now()) this.warmed.delete(id);
    return until > Date.now();
  }

  forgetWarm(key: ManagedKey) {
    this.warmed.delete(unstable_serialize(key));
  }

  warm(key: ManagedKey) {
    // Only the fixed, small prefetch allowlist uses this map.
    this.warmed.set(unstable_serialize(key), Date.now() + 5000);
  }

  read<T>(key: ManagedKey): Promise<T> {
    const id = unstable_serialize(key);
    const previous = this.flights.get(id);
    if (previous && !previous.controller.signal.aborted) {
      return previous.promise as Promise<T>;
    }
    const [path, params] = typeof key === "string" ? [key, undefined] : key;
    const controller = new AbortController();
    const promise = axios
      .get<T>(path, {
        params,
        signal: controller.signal,
        timeout: 15000,
      })
      .then(({ data }) => data)
      .finally(() => {
        if (this.flights.get(id)?.controller === controller)
          this.flights.delete(id);
      });
    this.flights.set(id, { controller, promise });
    return promise;
  }
}

const pools = new WeakMap<object, ManagedReads>();
export function managedReadsFor(cache: object) {
  let pool = pools.get(cache);
  if (!pool) {
    pool = new ManagedReads();
    pools.set(cache, pool);
  }
  return pool;
}
