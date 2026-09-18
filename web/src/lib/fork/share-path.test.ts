import { describe, expect, it } from "vitest";
import { isPublicSharePath, isShareToken, shareExpiry } from "./share-path";

describe("isShareToken", () => {
  it("accepts what the server issues", () => {
    expect(isShareToken("e2eShareToken123456789012345678")).toBe(true);
    expect(isShareToken("abc_DEF-123")).toBe(true);
  });

  it.each([
    undefined,
    "",
    "short",
    "a".repeat(65),
    "has space 12345",
    "../../etc/passwd",
    "token?x=12345678",
    "tok%2Fen12345678",
  ])("rejects %s", (value) => {
    expect(isShareToken(value)).toBe(false);
  });
});

describe("shareExpiry", () => {
  const now = 1_800_000_000;

  it("uses the largest unit that fits, rounded down", () => {
    expect(shareExpiry(now + 59, now)).toEqual({ unit: "minutes", count: 0 });
    expect(shareExpiry(now + 45 * 60, now)).toEqual({
      unit: "minutes",
      count: 45,
    });
    expect(shareExpiry(now + 3600, now)).toEqual({ unit: "hours", count: 1 });
    expect(shareExpiry(now + 24 * 3600 - 1, now)).toEqual({
      unit: "hours",
      count: 23,
    });
    expect(shareExpiry(now + 47 * 3600, now)).toEqual({
      unit: "hours",
      count: 47,
    });
    expect(shareExpiry(now + 7 * 86400, now)).toEqual({
      unit: "days",
      count: 7,
    });
  });

  it("never goes negative for a link that just expired", () => {
    expect(shareExpiry(now - 30, now)).toEqual({ unit: "minutes", count: 0 });
  });
});

describe("isPublicSharePath", () => {
  it("matches the share page with or without a base path", () => {
    expect(isPublicSharePath("/share/abc")).toBe(true);
    expect(isPublicSharePath("/frigate/share/abc")).toBe(true);
    expect(isPublicSharePath("/review")).toBe(false);
  });
});
