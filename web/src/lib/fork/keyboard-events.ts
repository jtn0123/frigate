/** Tell keys other code already handled apart from keys a shortcut hook handled. */

const handledByShortcut = new WeakSet<Event>();

/** Record that a `useKeyboardListener` instance prevented this event. */
export function markShortcutHandled(event: Event): void {
  handledByShortcut.add(event);
}

/**
 * Whether code other than a `useKeyboardListener` instance prevented this
 * event. Radix dismisses a dialog or menu on Escape in a capture-phase
 * listener and calls `preventDefault()` without stopping propagation, so a
 * page shortcut that still ran would act on the same key press (clearing a
 * selection while the key only closed a confirm dialog). Shortcut hooks keep
 * seeing events another shortcut hook prevented, as before.
 */
export function handledElsewhere(event: Event): boolean {
  return event.defaultPrevented && !handledByShortcut.has(event);
}
