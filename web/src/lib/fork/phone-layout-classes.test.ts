import { describe, expect, it } from "vitest";
import { fullscreenControlsClass } from "./phone-fullscreen";
import { mobilePageRootClass } from "./phone-shell";
import { pointHitStrokeWidth } from "./phone-target";

describe("mobilePageRootClass", () => {
  const shell = { bar: "bar", pageRoot: "shell-root", mobilePage: "page" };

  it("uses the phone shell when the flag provides one", () => {
    expect(mobilePageRootClass(shell, true)).toBe("shell-root");
    expect(mobilePageRootClass(shell, false)).toBe("shell-root");
  });

  it("falls back to upstream's PWA insets", () => {
    const pwa = mobilePageRootClass(undefined, true);
    expect(pwa).toContain("bottom-[calc(3rem+env(safe-area-inset-bottom))]");
    expect(pwa).toContain("pt-[env(safe-area-inset-top)]");
  });

  it("falls back to upstream's tab classes", () => {
    expect(mobilePageRootClass(undefined, false)).toBe(
      "bottom-12 left-0 md:bottom-16",
    );
  });
});

describe("fullscreenControlsClass", () => {
  it("uses the phone rail when there is one", () => {
    expect(fullscreenControlsClass("rail", true)).toBe("rail");
  });

  it("moves upstream's corner controls in mobile landscape", () => {
    expect(fullscreenControlsClass(undefined, true)).toBe(
      "absolute right-32 top-1 z-40 landscape:bottom-1 landscape:left-2 landscape:right-auto landscape:top-auto",
    );
  });

  it("keeps upstream's desktop class, trailing space included", () => {
    expect(fullscreenControlsClass(undefined, false)).toBe(
      "absolute right-32 top-1 z-40 ",
    );
  });
});

describe("pointHitStrokeWidth", () => {
  it("grows the grab area on a phone", () => {
    expect(pointHitStrokeWidth(0, true)).toBe(36);
    expect(pointHitStrokeWidth(3, true)).toBe(32);
  });

  it("keeps upstream's widths elsewhere", () => {
    expect(pointHitStrokeWidth(0, false)).toBe(12);
    expect(pointHitStrokeWidth(3, false)).toBe(9);
  });
});
