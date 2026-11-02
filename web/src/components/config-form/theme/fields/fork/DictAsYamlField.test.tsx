import { fireEvent, render, screen } from "@testing-library/react";
import type { FieldProps } from "@rjsf/utils";
import { describe, expect, it, vi } from "vitest";
import { DictAsYamlField } from "../DictAsYamlField";

const PATH = ["ffmpeg", "env"];

function setup(formData: unknown) {
  const onChange = vi.fn<(value: unknown, path: string[]) => void>();
  const props = {
    formData,
    onChange,
    disabled: false,
    readonly: false,
    idSchema: { $id: "root_env" },
    fieldPathId: { path: PATH },
    schema: {},
    registry: { formContext: { t: () => undefined } },
  };
  const fieldProps = (value: unknown) => value as FieldProps;
  render(<DictAsYamlField {...fieldProps(props)} />);
  return { onChange, textarea: screen.getByRole("textbox") };
}

// js-yaml 5 moved to named exports (F18); these cover dump, load and
// YAMLException through the field.
describe("DictAsYamlField", () => {
  it("shows a mapping as block YAML", () => {
    const { textarea } = setup({ TZ: "UTC", nested: { a: 1 } });
    expect(textarea).toHaveValue("TZ: UTC\nnested:\n  a: 1");
  });

  it("sends a parsed mapping on edit", () => {
    const { onChange, textarea } = setup({});
    fireEvent.change(textarea, { target: { value: "LIBVA_DRIVER: iHD" } });
    expect(onChange).toHaveBeenCalledWith({ LIBVA_DRIVER: "iHD" }, PATH);
  });

  it("reports the parser's reason for invalid YAML and keeps the value", () => {
    const { onChange, textarea } = setup({ TZ: "UTC" });
    fireEvent.change(textarea, { target: { value: "a: [1, 2" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/flow collection|unexpected end/i)).toBeVisible();
  });

  it("rejects YAML that is not a mapping", () => {
    const { onChange, textarea } = setup({});
    fireEvent.change(textarea, { target: { value: "- one\n- two" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Must be a YAML mapping")).toBeVisible();
  });
});
