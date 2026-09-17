import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import useKeyboardListener from "./use-keyboard-listener";

function press(key: string) {
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

// stands in for a Radix dialog: it dismisses on Escape in the capture phase
// and calls preventDefault without stopping propagation
const dismissOnEscape = (event: KeyboardEvent) => {
  if (event.key === "Escape") event.preventDefault();
};

describe("useKeyboardListener", () => {
  afterEach(() => {
    document.removeEventListener("keydown", dismissOnEscape, true);
  });

  it("ignores a key a dialog already handled", () => {
    const listener = vi.fn(() => true);
    renderHook(() => useKeyboardListener(["Escape"], listener));
    document.addEventListener("keydown", dismissOnEscape, true);

    press("Escape");

    expect(listener).not.toHaveBeenCalled();
  });

  it("handles a key nothing else handled", () => {
    const listener = vi.fn(() => true);
    renderHook(() => useKeyboardListener(["Escape"], listener));

    press("Escape");

    expect(listener).toHaveBeenCalledWith(
      "Escape",
      expect.objectContaining({ down: true }),
    );
  });

  it("still passes a key to every shortcut hook that listens for it", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    renderHook(() => useKeyboardListener(["a"], first));
    renderHook(() => useKeyboardListener(["a"], second));

    press("a");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
