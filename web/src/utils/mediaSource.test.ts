import { afterEach, describe, expect, it, vi } from "vitest";
import { getManagedMediaSourceConstructor } from "./mediaSource";

afterEach(() => vi.unstubAllGlobals());

describe("managed media source detection", () => {
  it("allows standard MediaSource fallback when the optional constructor is absent", () => {
    vi.stubGlobal("ManagedMediaSource", undefined);
    expect(getManagedMediaSourceConstructor()).toBeUndefined();
  });
  it("returns the browser constructor and preserves its static codec API", () => {
    class ManagedSource {
      static isTypeSupported = vi.fn(() => true);
    }
    vi.stubGlobal("ManagedMediaSource", ManagedSource);
    const Constructor = getManagedMediaSourceConstructor();
    expect(Constructor).toBe(ManagedSource);
    expect(new Constructor!()).toBeInstanceOf(ManagedSource);
    expect(Constructor!.isTypeSupported("video/mp4")).toBe(true);
  });
  it("ignores a present but non-callable property", () => {
    vi.stubGlobal("ManagedMediaSource", {});
    expect(getManagedMediaSourceConstructor()).toBeUndefined();
  });
});
