import { describe, expect, it } from "vitest";
import { countHatches } from "./type-ratchet.mjs";

describe("countHatches", () => {
  it("counts the three escape hatches and no-explicit-any disables", () => {
    const source = `
      const x = value as unknown as Config;
      // @ts-expect-error upstream type
      fn(x);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const y: any = 1;
      const z = foo as any;
    `;
    expect(countHatches(source)).toEqual({
      explicitAny: 2,
      tsExpectError: 1,
      asUnknownAs: 1,
      noExplicitAnyDisable: 1,
    });
  });

  it("counts no-explicit-any disables in rule lists and block comments", () => {
    const rule = "@typescript-eslint/no-explicit-any";
    const source = [
      `// eslint-disable-next-line react-hooks/exhaustive-deps, ${rule}`,
      `/* eslint-disable ${rule} */`,
      `/* eslint-disable\n  ${rule} */`,
      // A disable-line directive is not counted.
      `const a = 1; // eslint-disable-line ${rule}`,
    ].join("\n");
    expect(countHatches(source).noExplicitAnyDisable).toBe(3);
  });

  it("stays linear on a long run of spaces after a directive", () => {
    // The previous pattern took seconds on this input (quadratic backtracking).
    const source = `// eslint-disable${" ".repeat(100_000)}x`;
    const start = performance.now();
    expect(countHatches(source).noExplicitAnyDisable).toBe(0);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("does not treat the English word any as a hatch", () => {
    expect(countHatches("so any trigger can open the palette")).toEqual({
      explicitAny: 0,
      tsExpectError: 0,
      asUnknownAs: 0,
      noExplicitAnyDisable: 0,
    });
  });
});
