import { describe, expect, it } from "vitest";
import { isApplePlatform } from "./platform";

describe("isApplePlatform", () => {
  it("recognizes Apple platforms", () => {
    expect(isApplePlatform({ platform: "MacIntel" })).toBe(true);
    expect(isApplePlatform({ platform: "iPhone" })).toBe(true);
    expect(
      isApplePlatform({ platform: "", userAgent: "(iPad; CPU OS 17)" }),
    ).toBe(true);
  });

  it("is false elsewhere or when the platform is unknown", () => {
    expect(isApplePlatform({ platform: "Win32" })).toBe(false);
    expect(isApplePlatform({ platform: "Linux x86_64" })).toBe(false);
    expect(isApplePlatform({})).toBe(false);
  });
});
