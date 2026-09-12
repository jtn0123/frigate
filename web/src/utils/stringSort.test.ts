import { describe, expect, it } from "vitest";
import { sortedStrings } from "./stringSort";

describe("sortedStrings", () => {
  it("preserves code-unit ordering used for cache keys and profile colors", () => {
    const input = Object.freeze([
      "é",
      "camera2",
      "Z",
      "camera10",
      "A",
      "a",
      "😀",
      "A",
    ]);
    expect(sortedStrings(input)).toEqual([
      "A",
      "A",
      "Z",
      "a",
      "camera10",
      "camera2",
      "é",
      "😀",
    ]);
    expect(input).toEqual([
      "é",
      "camera2",
      "Z",
      "camera10",
      "A",
      "a",
      "😀",
      "A",
    ]);
  });

  it("returns an independent array that callers can reverse", () => {
    const cached = Object.freeze(["002.webp", "001.webp"]);
    expect(sortedStrings(cached).reverse()).toEqual(["002.webp", "001.webp"]);
    expect(cached).toEqual(["002.webp", "001.webp"]);
  });

  it("accepts empty collections and sets without losing values", () => {
    expect(sortedStrings([])).toEqual([]);
    expect(sortedStrings(new Set(["b", "a"]))).toEqual(["a", "b"]);
  });
});
