import { describe, expect, it } from "vitest";
import { getUnitSize, getUnitSizeFromBytes } from "@/utils/storageUtil";

describe("getUnitSizeFromBytes", () => {
  it("shows small sizes in bytes and KiB", () => {
    expect(getUnitSizeFromBytes(0)).toBe("0 B");
    expect(getUnitSizeFromBytes(1023)).toBe("1023 B");
    expect(getUnitSizeFromBytes(1536)).toBe("1.50 KiB");
  });

  it("hands MiB and larger to getUnitSize", () => {
    expect(getUnitSizeFromBytes(5 * 1048576)).toBe("5.00 MiB");
    expect(getUnitSizeFromBytes(3 * 1073741824)).toBe(getUnitSize(3 * 1024));
  });

  it("rejects negative and non-numeric input", () => {
    expect(getUnitSizeFromBytes(-1)).toBe("Invalid number");
    expect(getUnitSizeFromBytes(Number.NaN)).toBe("Invalid number");
  });
});
