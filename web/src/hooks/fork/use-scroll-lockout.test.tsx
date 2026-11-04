import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useScrollLockout } from "@/hooks/use-mouse-listener";

it("locks on scroll and unlocks on mouse move", () => {
  const element = document.createElement("div");
  const ref = { current: element };
  const { result, rerender } = renderHook(() => useScrollLockout(ref));

  expect(result.current).toBe(false);

  act(() => {
    element.dispatchEvent(new Event("scroll"));
  });
  rerender();
  expect(result.current).toBe(true);

  act(() => {
    element.dispatchEvent(new MouseEvent("mousemove"));
  });
  rerender();
  expect(result.current).toBe(false);
});
