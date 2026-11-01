import { fireEvent, render, screen } from "@testing-library/react";
import type { FieldProps } from "@rjsf/utils";
import { describe, expect, it, vi } from "vitest";
import { KnownPlatesField } from "../KnownPlatesField";

vi.mock("swr", () => ({ default: () => ({ data: [] }) }));

const PATH = ["lpr", "known_plates"];

// each entry has its own add-plate button; the entry Add comes last
function addEntryButton(): HTMLElement {
  const button = screen.getAllByRole("button", { name: "button.add" }).at(-1);
  if (!button) {
    throw new Error("no Add button");
  }
  return button;
}

function setup(formData: Record<string, string[]>) {
  const onChange = vi.fn<(value: unknown, path: string[]) => void>();
  const props = {
    formData,
    onChange,
    disabled: false,
    readonly: false,
    schema: { type: "object" },
    idSchema: { $id: "root_known_plates" },
    fieldPathId: { path: PATH },
    registry: {
      formContext: {
        sectionI18nPrefix: "lpr",
        t: (key: string) => key,
      },
    },
  };
  const fieldProps = (value: unknown) => value as FieldProps;
  render(<KnownPlatesField {...fieldProps(props)} />);
  return { onChange };
}

describe("KnownPlatesField (fork UI155)", () => {
  it("adds an unnamed entry next to the named ones", () => {
    const { onChange } = setup({ Alice: ["ABC123"] });
    fireEvent.click(addEntryButton());
    expect(onChange).toHaveBeenCalledWith(
      { Alice: ["ABC123"], "": [""] },
      PATH,
    );
  });

  it("keeps Add off while an unnamed entry exists, so its plates survive", () => {
    const { onChange } = setup({ "": ["ABC123"] });
    const add = addEntryButton();
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(onChange).not.toHaveBeenCalled();
  });
});
