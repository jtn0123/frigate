import { describe, expect, it } from "vitest";
import { matchesTrainClass, trainClassName } from "./classification-train";

describe("classification train classes", () => {
  it("names a class the way the backend writes it into file names", () => {
    expect(trainClassName("half-open")).toBe("half_open");
    expect(trainClassName("closed")).toBe("closed");
  });

  it("matches a dashed dataset class to its underscored train images", () => {
    expect(matchesTrainClass(["half-open"], "half_open")).toBe(true);
    expect(matchesTrainClass(["half_open"], "half_open")).toBe(true);
  });

  it("does not match other classes", () => {
    expect(matchesTrainClass(["half-open"], "closed")).toBe(false);
    expect(matchesTrainClass([], "closed")).toBe(false);
  });
});
