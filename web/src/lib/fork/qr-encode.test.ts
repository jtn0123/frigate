import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encode } from "./qr-encode";

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
