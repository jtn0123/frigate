/** Return Safari's optional constructor only when the browser provides it. */
export function getManagedMediaSourceConstructor():
  typeof MediaSource | undefined {
  const browser = window as typeof window & {
    ManagedMediaSource?: typeof MediaSource;
  };
  return typeof browser.ManagedMediaSource === "function"
    ? browser.ManagedMediaSource
    : undefined;
}
