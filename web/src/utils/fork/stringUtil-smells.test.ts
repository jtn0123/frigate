import { describe, expect, it, vi } from "vitest";
import { formatList, generateFixedHash } from "@/utils/stringUtil";

vi.mock("i18next", () => ({
  t: (key: string, options: { items?: string; last?: string }) =>
    `${key}|${String(options.items)}|${String(options.last)}`,
}));

describe("stringUtil", () => {
  it("hashes a name to a prefixed eight character id", () => {
    const hash = generateFixedHash("Front Door", "cam");

    expect(hash).toMatch(/^cam_[a-f][0-9a-f]{7}$/);
    expect(generateFixedHash("Front Door", "cam")).toBe(hash);
    expect(generateFixedHash("Back Door", "cam")).not.toBe(hash);
  });

  it("never starts the hash with a digit", () => {
    for (const name of ["a", "b", "c", "d", "e", "f", "g", "h", "カメラ"]) {
      expect(generateFixedHash(name)).toMatch(/^id_[a-f]/);
    }
  });

  it("passes the last item of a long list separately", () => {
    expect(formatList(["a", "b", "c"])).toBe(
      "list.many|a" + "list.separatorWithSpace|undefined|undefined" + "b|c",
    );
  });
});
