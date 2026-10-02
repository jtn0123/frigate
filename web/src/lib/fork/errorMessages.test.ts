import { describe, expect, it, vi } from "vitest";
import type { RJSFValidationError } from "@rjsf/utils";
import type { i18n as I18n } from "i18next";
import {
  createErrorTransformer,
  extractFieldPath,
  transformPydanticErrors,
} from "@/lib/config-schema/errorMessages";

// only the two methods the transformer calls
const asI18n = (value: unknown) => value as I18n;

function fakeI18n(keys: Record<string, string>) {
  const t = vi.fn((key: string, params?: Record<string, unknown>) => {
    const ns = params?.["ns"] as string[] | undefined;
    const template = keys[ns ? `${ns[0]}:${key}` : key] ?? key;
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      String(params?.[name] ?? ""),
    );
  });
  const exists = vi.fn(
    (key: string, options?: { ns?: string }) =>
      (options?.ns ? `${options.ns}:${key}` : key) in keys,
  );
  const i18n = asI18n({ t, exists });
  return { i18n, t, exists };
}

function error(partial: Partial<RJSFValidationError>): RJSFValidationError {
  return { stack: "", ...partial } as RJSFValidationError;
}

describe("createErrorTransformer", () => {
  it("prefers a field-specific message", () => {
    const { i18n } = fakeI18n({
      "detect.fps.validation.minimum": "fps must be at least {{limit}}",
      "config/validation:minimum": "generic",
    });
    const [result] = createErrorTransformer(i18n)([
      error({ name: "minimum", property: ".detect.fps", params: { limit: 1 } }),
    ]);
    expect(result?.message).toBe("fps must be at least 1");
  });

  it("uses the missing property for required errors", () => {
    const { i18n, exists } = fakeI18n({
      "detect.width.validation.required": "width is required",
      "width.validation.required": "top-level width is required",
    });
    const transform = createErrorTransformer(i18n);
    expect(
      transform([
        error({
          name: "required",
          property: ".detect",
          params: { missingProperty: "width" },
        }),
      ])[0]?.message,
    ).toBe("width is required");
    expect(
      transform([
        error({
          name: "required",
          property: "",
          params: { missingProperty: "width" },
        }),
      ])[0]?.message,
    ).toBe("top-level width is required");
    expect(exists).toHaveBeenCalledWith("width.validation.required");
  });

  it("falls back to the generic message and joins allowed values", () => {
    const { i18n, t } = fakeI18n({
      "config/validation:enum": "must be one of {{allowedValues}}",
    });
    const [result] = createErrorTransformer(i18n)([
      error({
        name: "enum",
        property: ".record.mode",
        params: { allowedValues: ["all", "motion"] },
        message: "original",
      }),
    ]);
    expect(t).toHaveBeenCalledWith("enum", {
      allowedValues: "all, motion",
      ns: ["config/validation"],
    });
    expect(result?.message).toBe("must be one of all, motion");
  });

  it("keeps the original error when no translation exists", () => {
    const { i18n } = fakeI18n({});
    const original = error({
      name: "type",
      property: ".x",
      params: undefined,
      message: "must be number",
    });
    expect(createErrorTransformer(i18n)([original])[0]).toBe(original);
  });

  it("skips errors without a keyword", () => {
    const { i18n, exists } = fakeI18n({});
    const original = error({ message: "odd" });
    expect(createErrorTransformer(i18n)([original])[0]).toBe(original);
    expect(exists).not.toHaveBeenCalled();
  });

  it("keeps a non-array allowedValues as is", () => {
    const { i18n, t } = fakeI18n({ "config/validation:const": "x" });
    createErrorTransformer(i18n)([
      error({ name: "const", params: { allowedValues: "only" } }),
    ]);
    expect(t).toHaveBeenCalledWith("const", {
      allowedValues: "only",
      ns: ["config/validation"],
    });
  });
});

describe("pydantic errors", () => {
  it("drops the FastAPI body prefix from the location", () => {
    expect(extractFieldPath(["body", "cameras", "front", "fps"])).toBe(
      "cameras.front.fps",
    );
    expect(extractFieldPath(["zones", 0, "name"])).toBe("zones.0.name");
  });

  it("maps errors to property and message pairs", () => {
    expect(
      transformPydanticErrors([
        { loc: ["body", "detect", "fps"], msg: "too low", type: "value_error" },
      ]),
    ).toEqual([{ property: "detect.fps", message: "too low" }]);
  });
});
