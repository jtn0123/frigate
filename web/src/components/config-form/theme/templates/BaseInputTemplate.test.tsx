import { fireEvent, render, screen } from "@testing-library/react";
import { getDefaultRegistry } from "@rjsf/core";
import { createSchemaUtils, type WidgetProps } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import { describe, expect, it, vi } from "vitest";
import { BaseInputTemplate } from "./BaseInputTemplate";

function renderInput(type: string | undefined, value: unknown) {
  const onChange = vi.fn();
  render(
    <BaseInputTemplate
      {...({
        id: "field",
        name: "field",
        label: "Field",
        type,
        value,
        onChange,
        onBlur: vi.fn(),
        onFocus: vi.fn(),
        schema: { title: "Field" },
        options: {},
        registry: {
          ...getDefaultRegistry(),
          schemaUtils: createSchemaUtils(validator, {}),
        },
      } satisfies WidgetProps)}
    />,
  );
  return { onChange, input: screen.getByLabelText("Field") };
}

describe("BaseInputTemplate", () => {
  it("passes a typed number through as a number", () => {
    const { onChange, input } = renderInput("number", undefined);
    fireEvent.change(input, { target: { value: "2.5" } });
    expect(onChange).toHaveBeenLastCalledWith(2.5);
  });

  it("clears a number field to undefined", () => {
    const { onChange, input } = renderInput("number", 3);
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("passes text through and clears an empty text field", () => {
    const { onChange, input } = renderInput(undefined, "a");
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).toHaveBeenLastCalledWith("abc");
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
