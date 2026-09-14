import { expect, it, vi } from "vitest";
import {
  clearNavigationSamples,
  navigationSnapshot,
  recordNavigationSample,
  subscribeNavigation,
} from "./navigation-metrics";
it("bounds browser history, notifies subscribers and clears measurements", () => {
  clearNavigationSamples();
  const listener = vi.fn();
  const unsubscribe = subscribeNavigation(listener);
  for (let i = 0; i < 110; i++)
    recordNavigationSample({
      kind: "request",
      target: "cases",
      outcome: "success",
      duration: i,
    });
  expect(navigationSnapshot()).toHaveLength(100);
  expect(navigationSnapshot()[0]?.duration).toBe(10);
  expect(listener).toHaveBeenCalledTimes(110);
  unsubscribe();
  clearNavigationSamples();
  expect(navigationSnapshot()).toEqual([]);
  expect(listener).toHaveBeenCalledTimes(110);
});
