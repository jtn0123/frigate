export type NavigationSample = {
  kind: "request" | "page";
  target: string;
  duration: number;
  outcome: "success" | "error" | "cancelled";
};
let samples: readonly NavigationSample[] = [];
const listeners = new Set<() => void>();

/** Keep bounded, browser-local timings without URLs, filters, or response data. */
export function recordNavigationSample(sample: NavigationSample) {
  samples = [...samples.slice(-99), sample];
  listeners.forEach((listener) => listener());
}
export function navigationSnapshot() {
  return samples;
}
export function subscribeNavigation(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function clearNavigationSamples() {
  samples = [];
  listeners.forEach((listener) => listener());
}
