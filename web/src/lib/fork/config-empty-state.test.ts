import { describe, expect, it } from "vitest";
import { configEmptyStateKind, isEmptyMap } from "./config-empty-state";

describe("configEmptyStateKind", () => {
  it("reads a known kind from the root ui:options", () => {
    expect(
      configEmptyStateKind({
        "ui:options": { forkEmptyState: "genaiProviders" },
      }),
    ).toBe("genaiProviders");
  });

  it("ignores missing and unknown kinds", () => {
    expect(configEmptyStateKind(undefined)).toBeUndefined();
    expect(configEmptyStateKind({ "ui:options": {} })).toBeUndefined();
    expect(
      configEmptyStateKind({ "ui:options": { forkEmptyState: "other" } }),
    ).toBeUndefined();
  });
});

describe("isEmptyMap", () => {
  it.each([undefined, null, {}])("treats %j as empty", (value) => {
    expect(isEmptyMap(value)).toBe(true);
  });

  it.each([{ openai: {} }, [], "text", 0])(
    "treats %j as not empty",
    (value) => {
      expect(isEmptyMap(value)).toBe(false);
    },
  );
});
