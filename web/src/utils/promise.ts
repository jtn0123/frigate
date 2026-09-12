/**
 * Helpers for promise-returning event handlers and fire-and-forget calls.
 *
 * Event props (`onClick`, `onSubmit`, …) are typed as void-returning. Passing
 * an `async` function there drops rejections. Wrap those handlers so the
 * caller is void and the promise is explicitly ignored after the callee has
 * handled errors (toasts, `.catch`, etc.).
 */

/**
 * Run `fn` and ignore the returned promise. `fn` must handle its own errors.
 */
export function wrapAsync<A extends unknown[]>(
  fn: (...args: A) => unknown,
): (...args: A) => void {
  return (...args: A) => {
    void Promise.resolve(fn(...args));
  };
}
