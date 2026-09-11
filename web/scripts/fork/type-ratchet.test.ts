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

  it("does not treat the English word any as a hatch", () => {
    expect(countHatches("so any trigger can open the palette")).toEqual({
      explicitAny: 0,
      tsExpectError: 0,
      asUnknownAs: 0,
      noExplicitAnyDisable: 0,
    });
  });
});
