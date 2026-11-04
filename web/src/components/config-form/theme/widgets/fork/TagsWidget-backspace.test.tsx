import { fireEvent, render, screen } from "@testing-library/react";
import { getDefaultRegistry } from "@rjsf/core";
import { createSchemaUtils, type WidgetProps } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import { expect, it, vi } from "vitest";
import { TagsWidget } from "../TagsWidget";

it("removes the last tag on Backspace in an empty input", () => {
  const onChange = vi.fn();
  render(
    <TagsWidget
      {...({
        id: "labels",
        name: "labels",
        label: "Labels",
        value: ["person", "car", "dog"],
        schema: { title: "Labels" },
        options: {},
        onChange,
        onBlur: vi.fn(),
        onFocus: vi.fn(),
        registry: {
          ...getDefaultRegistry(),
          schemaUtils: createSchemaUtils(validator, {}),
        },
      } satisfies WidgetProps)}
    />,
  );

  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Backspace" });

  expect(onChange).toHaveBeenCalledWith(["person", "car"]);
});
