import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { onActivate } from "./a11y";

function keyEvent(key: string, nested = false) {
  const element = document.createElement("div");
  const child = document.createElement("button");
  element.append(child);
  return {
    key,
    target: nested ? child : element,
    currentTarget: element,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent<HTMLElement>;
}

describe("onActivate", () => {
  it("runs the handler on Enter and Space, like a native button", () => {
    const handler = vi.fn();
    const onKeyDown = onActivate(handler)!;

    onKeyDown(keyEvent("Enter"));
    onKeyDown(keyEvent(" "));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("keeps Space from scrolling the page", () => {
    const event = keyEvent(" ");
    onActivate(vi.fn())!(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    const handler = vi.fn();
    const event = keyEvent("a");
    onActivate(handler)!(event);
    expect(handler).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves a key press on a nested control to that control", () => {
    const handler = vi.fn();
    onActivate(handler)!(keyEvent("Enter", true));
    expect(handler).not.toHaveBeenCalled();
  });

  it("adds no key handler when there is nothing to run", () => {
    expect(onActivate(undefined)).toBeUndefined();
  });
});
