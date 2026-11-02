import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  setCommandPaletteOpen,
  useCommandPaletteOpen,
  useCommandPaletteShortcuts,
} from "./use-command-palette";

function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("useCommandPaletteShortcuts", () => {
  afterEach(() => {
    act(() => setCommandPaletteOpen(false));
    document.body.innerHTML = "";
  });

  function setup() {
    renderHook(() => useCommandPaletteShortcuts());
    return renderHook(() => useCommandPaletteOpen());
  }

  it("toggles with Ctrl+K outside a text field", () => {
    const open = setup();
    const event = press(document.body, { key: "k", ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(open.result.current[0]).toBe(true);
    press(document.body, { key: "K", metaKey: true });
    expect(open.result.current[0]).toBe(false);
  });

  it("leaves Ctrl+K to a focused text field while closed", () => {
    const open = setup();
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    const event = press(editor, { key: "k", ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(open.result.current[0]).toBe(false);
  });

  it("closes from the palette's own input", () => {
    const open = setup();
    act(() => setCommandPaletteOpen(true));
    const input = document.createElement("input");
    document.body.appendChild(input);
    press(input, { key: "k", ctrlKey: true });
    expect(open.result.current[0]).toBe(false);
  });

  it("ignores Ctrl+Alt+K", () => {
    const open = setup();
    press(document.body, { key: "k", ctrlKey: true, altKey: true });
    expect(open.result.current[0]).toBe(false);
  });

  it("opens with slash only outside a text field", () => {
    const open = setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    press(input, { key: "/" });
    expect(open.result.current[0]).toBe(false);
    const event = press(document.body, { key: "/" });
    expect(event.defaultPrevented).toBe(true);
    expect(open.result.current[0]).toBe(true);
  });
});
