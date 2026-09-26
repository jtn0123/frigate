import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCodecFamilySupported } from "@/utils/codecSupport";

type TypeCheck = (mimeType: string) => boolean;

function mediaSource(check: TypeCheck) {
  return { isTypeSupported: vi.fn(check) };
}

let canPlayType: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("ManagedMediaSource", undefined);
  vi.stubGlobal("MediaSource", undefined);
  canPlayType = vi.fn(() => "");
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(
    (tag: string, options?: ElementCreationOptions) => {
      const element = createElement(tag, options);
      if (tag === "video") {
        Object.defineProperty(element, "canPlayType", { value: canPlayType });
      }
      return element;
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isCodecFamilySupported", () => {
  it("fails open for missing and unknown codecs without probing", () => {
    expect(isCodecFamilySupported(null)).toBe(true);
    expect(isCodecFamilySupported(undefined)).toBe(true);
    expect(isCodecFamilySupported("")).toBe(true);
    expect(isCodecFamilySupported("mjpeg")).toBe(true);
    expect(canPlayType).not.toHaveBeenCalled();
  });

  it("accepts the family when ManagedMediaSource supports a sample", () => {
    const managed = mediaSource((type) => type.includes("hvc1"));
    vi.stubGlobal("ManagedMediaSource", managed);
    vi.stubGlobal(
      "MediaSource",
      mediaSource(() => false),
    );
    expect(isCodecFamilySupported("HEVC")).toBe(true);
    expect(managed.isTypeSupported).toHaveBeenCalledWith(
      'video/mp4; codecs="hvc1.1.6.L120.90"',
    );
  });

  it("falls through to MediaSource when ManagedMediaSource rejects", () => {
    vi.stubGlobal(
      "ManagedMediaSource",
      mediaSource(() => false),
    );
    const mse = mediaSource((type) => type.includes("av01"));
    vi.stubGlobal("MediaSource", mse);
    expect(isCodecFamilySupported("av1")).toBe(true);
    expect(mse.isTypeSupported).toHaveBeenCalled();
    expect(canPlayType).not.toHaveBeenCalled();
  });

  it("uses native video playback when MSE is unavailable", () => {
    canPlayType.mockImplementation((type: string) =>
      type.includes("avc1.64001F") ? "maybe" : "",
    );
    expect(isCodecFamilySupported("h264")).toBe(true);
    expect(canPlayType).toHaveBeenCalledTimes(2);
  });

  it("reports unsupported when every probe rejects every sample", () => {
    vi.stubGlobal(
      "MediaSource",
      mediaSource(() => false),
    );
    expect(isCodecFamilySupported("hevc")).toBe(false);
    expect(canPlayType).toHaveBeenCalledTimes(2);
  });

  it("maps aliases and trims whitespace before probing", () => {
    const mse = mediaSource((type) => type.includes("hvc1"));
    vi.stubGlobal("MediaSource", mse);
    for (const alias of [" H265 ", "hev1", "hvc1"]) {
      expect(isCodecFamilySupported(alias)).toBe(true);
    }
    const h264 = mediaSource((type) => type.includes("avc1"));
    vi.stubGlobal("MediaSource", h264);
    for (const alias of ["avc", "AVC1"]) {
      expect(isCodecFamilySupported(alias)).toBe(true);
    }
    const av1 = mediaSource((type) => type.includes("av01"));
    vi.stubGlobal("MediaSource", av1);
    expect(isCodecFamilySupported("av01")).toBe(true);
  });
});
