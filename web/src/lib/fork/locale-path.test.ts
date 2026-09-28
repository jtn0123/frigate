import { describe, expect, it } from "vitest";
import { localeLoadPath } from "./locale-path";

describe("localeLoadPath", () => {
  const loadPath = localeLoadPath("/frigate/", "abc123");

  it("keeps the language placeholder for translated namespaces", () => {
    expect(loadPath(["de"], ["common"])).toBe(
      "/frigate/locales/{{lng}}/{{ns}}.json?v=abc123",
    );
  });

  it("loads the English-only fork namespace from en in any language", () => {
    expect(loadPath(["de"], ["fork"])).toBe(
      "/frigate/locales/en/{{ns}}.json?v=abc123",
    );
    expect(loadPath(["en"], ["fork"])).toBe(
      "/frigate/locales/en/{{ns}}.json?v=abc123",
    );
  });
});
