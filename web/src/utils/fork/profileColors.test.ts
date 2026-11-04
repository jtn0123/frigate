import { expect, it } from "vitest";
import { getProfileColor } from "@/utils/profileColors";

it("gives an unknown profile the first color", () => {
  expect(getProfileColor("missing", ["away", "home"])).toEqual(
    getProfileColor("away", ["away", "home"]),
  );
  expect(getProfileColor("home", ["away", "home"])).not.toEqual(
    getProfileColor("away", ["away", "home"]),
  );
});
