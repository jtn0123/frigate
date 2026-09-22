import { describe, expect, it } from "vitest";
import { isRailSearchItem } from "./nav-search";
import {
  ID_EXPLORE,
  ID_LIVE,
  ID_REVIEW,
  ID_EXPORT,
} from "@/hooks/use-navigation";

describe("isRailSearchItem", () => {
  it("draws the Explore slot as the search button", () => {
    expect(isRailSearchItem(ID_EXPLORE)).toBe(true);
  });

  it("leaves every other rail entry a link", () => {
    for (const id of [ID_LIVE, ID_REVIEW, ID_EXPORT]) {
      expect(isRailSearchItem(id)).toBe(false);
    }
  });
});
