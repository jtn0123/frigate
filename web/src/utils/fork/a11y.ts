import type { KeyboardEvent, KeyboardEventHandler } from "react";

/**
 * Keyboard activation for non-button elements that carry an onClick.
 *
 * Native buttons fire their click handler on Enter and Space. Elements that
 * only add role="button" and tabIndex do not, so pair them with
 * `onKeyDown={onActivate(handler)}` to get the same behaviour.
 *
 * The handler only runs when the element itself is the event target, so a
 * key press on a nested control (a real button inside a card, for example)
 * is left to that control and is never doubled up.
 */
export function onActivate<T extends Element = HTMLElement>(
  handler?: (event: KeyboardEvent<T>) => void,
): KeyboardEventHandler<T> | undefined {
  if (!handler) {
    return undefined;
  }

  return (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    if (event.target !== event.currentTarget) {
      return;
    }

    // Space would otherwise scroll the page.
    event.preventDefault();
    handler(event);
  };
}
