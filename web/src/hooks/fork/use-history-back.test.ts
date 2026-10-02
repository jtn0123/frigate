import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHistoryBack } from "@/hooks/use-history-back";

// Exercise the upstream implementation; the fork variant has its own tests.
vi.mock("@/fork/flags", () => ({ forkFlags: { phoneFixes: false } }));

type Props = { enabled: boolean; open: boolean; onClose: () => void };

function setup(initialProps: Props) {
  return renderHook((props: Props) => useHistoryBack(props), { initialProps });
}

let push: ReturnType<typeof vi.spyOn>;
let back: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  window.history.replaceState(null, "", "/review?cameras=front");
  push = vi.spyOn(window.history, "pushState");
  back = vi.spyOn(window.history, "back").mockImplementation(() => {});
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("useHistoryBack (upstream)", () => {
  it("does nothing while disabled", () => {
    const onClose = vi.fn();
    const { rerender } = setup({ enabled: false, open: true, onClose });
    rerender({ enabled: false, open: false, onClose });
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(push).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pushes one entry when opened and pops it when closed normally", () => {
    const onClose = vi.fn();
    const { rerender } = setup({ enabled: true, open: true, onClose });
    // a new onClose must not push another entry
    rerender({ enabled: true, open: true, onClose: vi.fn() });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ overlayOpen: true }, "");

    rerender({ enabled: true, open: false, onClose });
    expect(back).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes with the latest onClose on back and does not go back again", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = setup({ enabled: true, open: true, onClose: first });
    rerender({ enabled: true, open: true, onClose: latest });

    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    rerender({ enabled: true, open: false, onClose: latest });
    expect(back).not.toHaveBeenCalled();

    // reopening pushes a fresh entry
    rerender({ enabled: true, open: true, onClose: latest });
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("keeps the entry when the url changed while open", () => {
    const onClose = vi.fn();
    const { rerender } = setup({ enabled: true, open: true, onClose });
    window.history.replaceState(null, "", "/review?cameras=back");
    rerender({ enabled: true, open: false, onClose });
    expect(back).not.toHaveBeenCalled();
  });

  it("stops listening after unmount", () => {
    const onClose = vi.fn();
    const { unmount } = setup({ enabled: true, open: true, onClose });
    unmount();
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
