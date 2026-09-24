import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  encode,
  renderANSI,
  renderSVG,
  renderUnicode,
  renderUnicodeCompact,
} from "./qr-encode";

type EncodedQr = {
  version: number;
  maskPattern: number;
  size: number;
  data: boolean[][];
  types: number[][];
};
type EncodeOptions = {
  ecc?: string;
  boostEcc?: boolean;
  minVersion?: number;
  maxVersion?: number;
  maskPattern?: number;
  border?: number;
  invert?: boolean;
  onEncoded?: (result: EncodedQr) => void;
  whiteChar?: string;
  blackChar?: string;
  pixelSize?: number;
  whiteColor?: string;
  blackColor?: string;
};
const typedEncode = encode as (
  data: string | number[],
  options?: EncodeOptions,
) => EncodedQr;
const typedRenderUnicode = renderUnicode as (
  data: string,
  options?: EncodeOptions,
) => string;
const typedRenderANSI = renderANSI as (
  data: string,
  options?: EncodeOptions,
) => string;
const typedRenderCompact = renderUnicodeCompact as (
  data: string,
  options?: EncodeOptions,
) => string;
const typedRenderSVG = renderSVG as (
  data: string,
  options?: EncodeOptions,
) => string;

// Frozen outputs from the vendored encoder before the control-flow cleanup.
const cases = [
  {
    name: "numeric",
    data: "12345678901234567890",
    options: {},
    digest: "91cc68348ceac7d48831690c4f3e841cc668d5126c4faa1f34ab47ea71fffff0",
  },
  {
    name: "pairing URL",
    data: "https://frigate.example/pair?code=sample",
    options: {
      ecc: "H",
    },
    digest: "b29b86a30d7dd7b97a52cfa3b0436272fbcd9d26f84ff3fa043e00c35cee5b78",
  },
  {
    name: "unicode",
    data: "Camera entrée 門",
    options: {
      ecc: "Q",
    },
    digest: "26e42261a7d99e437e130d580a9c82f1485c9211a36468a9865bc322d3e842e9",
  },
  {
    name: "alignment version 7",
    data: "Frigate",
    options: {
      minVersion: 7,
      maxVersion: 7,
    },
    digest: "bd9ddf4b73b27594b7a17d02b664918ee435d5a00d110ba768d5dbb11f1b8a27",
  },
  {
    name: "alignment version 32",
    data: "Frigate",
    options: {
      minVersion: 32,
      maxVersion: 32,
    },
    digest: "7e9b0df45cbd87d871fbe58f2a8fbd565e3babf52f98c4884c7c9e900f4a2d90",
  },
  {
    name: "largest version",
    data: "Frigate",
    options: {
      minVersion: 40,
      maxVersion: 40,
    },
    digest: "d63b1bf6bbd4440fee22ecbbe57c8f30eba4dfa28df6475108797de5fb4b7379",
  },
  {
    name: "binary",
    data: [0, 127, 128, 255],
    options: {
      ecc: "M",
    },
    digest: "ff200940b0911d6cd99db50d27f2c8452bde071f2c206367b97a1cb9548cfcdf",
  },
];

describe("QR encoding compatibility", () => {
  it.each(cases)(
    "preserves $name modules and masks",
    ({ data, options, digest }) => {
      expect(
        createHash("sha256")
          .update(JSON.stringify(encode(data, options)))
          .digest("hex"),
      ).toBe(digest);
    },
  );
});

describe("QR public options and renderers", () => {
  it("rejects unsupported input, invalid versions and masks, and data too long for a fixed version", () => {
    expect(() => typedEncode(123 as never)).toThrow(/only supports encoding/);
    expect(() => typedEncode("x", { minVersion: 2, maxVersion: 1 })).toThrow(
      RangeError,
    );
    expect(() => typedEncode("x", { maskPattern: 8 })).toThrow(RangeError);
    expect(() =>
      typedEncode("x".repeat(300), { minVersion: 1, maxVersion: 1 }),
    ).toThrow("Data too long");
  });

  it("uses the requested mask, border and inversion, and reports the encoded result", () => {
    const onEncoded = vi.fn();
    const plain = typedEncode("FRIGATE 1", { border: 0, maskPattern: 6 });
    const inverted = typedEncode("FRIGATE 1", {
      border: 2,
      maskPattern: 6,
      invert: true,
      onEncoded,
    });
    expect(plain.maskPattern).toBe(6);
    expect(inverted.maskPattern).toBe(6);
    expect(inverted.size).toBe(plain.size + 4);
    expect(inverted.types[0]?.every((type) => type === -1)).toBe(true);
    expect(inverted.data[0]?.every(Boolean)).toBe(true);
    expect(inverted.data[2]?.[2]).toBe(!plain.data[0]?.[0]);
    expect(onEncoded).toHaveBeenCalledOnce();
    expect(onEncoded).toHaveBeenCalledWith(inverted);
  });

  it("boosts correction only when requested and leaves the supplied payload intact", () => {
    const bytes = [0, 127, 128, 255];
    const low = typedEncode(bytes, { ecc: "L", boostEcc: false, border: 0 });
    const boosted = typedEncode(bytes, { ecc: "L", boostEcc: true, border: 0 });
    expect(bytes).toEqual([0, 127, 128, 255]);
    expect(low.version).toBe(boosted.version);
    expect(low.data).not.toEqual(boosted.data);
  });

  it("renders Unicode, ANSI, compact Unicode and SVG from the same modules", () => {
    const encoded = typedEncode("A", { border: 0, maskPattern: 0 });
    const unicode = typedRenderUnicode("A", {
      border: 0,
      maskPattern: 0,
      whiteChar: ".",
      blackChar: "#",
    });
    expect(unicode.split("\n")).toHaveLength(encoded.size);
    expect(unicode.split("\n")[0]).toBe(
      encoded.data[0]?.map((dark) => (dark ? "#" : ".")).join(""),
    );
    expect(typedRenderANSI("A", { border: 0, maskPattern: 0 })).toContain(
      "\x1B[40m",
    );
    const compact = typedRenderCompact("A", { border: 0, maskPattern: 0 });
    expect(compact.split("\n")).toHaveLength(Math.ceil(encoded.size / 2));
    expect(
      compact.split("\n").every((line) => line.length === encoded.size),
    ).toBe(true);
    const svg = typedRenderSVG("A", {
      border: 0,
      maskPattern: 0,
      pixelSize: 2,
      whiteColor: "#fff",
      blackColor: "#000",
    });
    expect(svg).toContain('viewBox="0 0 42 42"');
    expect(svg).toContain('<rect fill="#fff" width="42" height="42"/>');
    expect(svg).toContain('<path fill="#000" d="M');
  });
});
