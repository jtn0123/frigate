import { describe, expect, it } from "vitest";
import { qrSvg } from "./qr";
import { isPublicSharePath, sharePageUrl } from "./share-path";

describe("qrSvg", () => {
  it("renders an SVG with finder-pattern sized content", () => {
    const svg = qrSvg("https://example.test/share/abc");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<path");
    expect(svg).toContain("viewBox");
  });
});

describe("sharePageUrl", () => {
  it("joins origin, base path and token", () => {
    window.baseUrl = "/nvr/";
    expect(sharePageUrl("tok", "https://cam.example")).toBe(
      "https://cam.example/nvr/share/tok",
    );
    window.baseUrl = undefined;
  });
});

describe("isPublicSharePath", () => {
  it("matches share pages with and without a basename", () => {
    expect(isPublicSharePath("/share/abc")).toBe(true);
    expect(isPublicSharePath("/nvr/share/abc")).toBe(true);
    expect(isPublicSharePath("/explore")).toBe(false);
    expect(isPublicSharePath("/review")).toBe(false);
  });
});
