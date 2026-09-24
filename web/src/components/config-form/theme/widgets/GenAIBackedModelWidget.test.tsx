import { fireEvent, render, screen } from "@testing-library/react";
import { getDefaultRegistry } from "@rjsf/core";
import { createSchemaUtils } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import type { WidgetProps } from "@rjsf/utils";
import { beforeAll, expect, it, vi } from "vitest";
import { GenAIBackedModelWidget } from "./GenAIBackedModelWidget";
import { GenAIBackedModelSizeWidget } from "./GenAIBackedModelSizeWidget";
import { AudioTranscriptionModelWidget } from "./AudioTranscriptionModelWidget";
import { AudioTranscriptionModelSizeWidget } from "./AudioTranscriptionModelSizeWidget";
import { LiveFormDataContext } from "../../LiveFormDataContext";

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
function props(overrides: Partial<WidgetProps> = {}): WidgetProps {
  return {
    id: "model",
    name: "model",
    label: "Model",
    value: "whisper",
    schema: { examples: ["whisper", 4, null] },
    options: {},
    registry: {
      ...getDefaultRegistry(),
      schemaUtils: createSchemaUtils(validator, {}),
    },
    onChange: vi.fn(),
    onBlur: vi.fn(),
    onFocus: vi.fn(),
    ...overrides,
  };
}

it("offers only providers holding the transcription role and keeps built-in selection", () => {
  const input = props();
  input.registry.formContext = {
    fullConfig: {
      genai: {
        cloud: { roles: ["transcribe"] },
        embeddings: { roles: ["embeddings"] },
        bad: null,
        list: [],
        noRoles: {},
      },
    },
  };
  render(<AudioTranscriptionModelWidget {...input} />);
  fireEvent.click(screen.getByRole("combobox"));
  expect(
    screen.queryByRole("option", { name: "embeddings" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: "cloud" }));
  expect(input.onChange).toHaveBeenLastCalledWith("cloud");
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: "whisper" }));
  expect(input.onChange).toHaveBeenLastCalledWith("whisper");
});

it("uses the embeddings role by default and labels an existing provider", () => {
  const input = props({ value: "embed", schema: {} });
  input.registry.formContext = {
    fullConfig: { genai: { embed: { roles: ["embeddings"] } } },
  };
  render(<GenAIBackedModelWidget {...input} />);
  expect(screen.getByRole("combobox")).toHaveTextContent("embed");
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: "embed" }));
  expect(input.onChange).toHaveBeenCalledWith("embed");
});

it("keeps unknown saved names visible and disables readonly or disabled inputs", () => {
  const input = props({ value: "old-provider", readonly: true });
  const { rerender } = render(<GenAIBackedModelWidget {...input} />);
  expect(screen.getByRole("combobox")).toBeDisabled();
  expect(screen.getByRole("combobox")).toHaveTextContent("old-provider");
  rerender(
    <GenAIBackedModelWidget
      {...input}
      readonly={false}
      disabled
      value={undefined}
    />,
  );
  expect(screen.getByRole("combobox")).toBeDisabled();
  expect(screen.getByRole("combobox")).toHaveTextContent(
    "configForm.semanticSearchModel.placeholder",
  );
});

it.each([undefined, [], "invalid"])(
  "handles malformed provider configuration %s",
  (genai) => {
    const input = props({ schema: {} });
    input.registry.formContext = { fullConfig: { genai } };
    render(<GenAIBackedModelWidget {...input} />);
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  },
);

it("clears custom local size on a provider and restores its default when returning to Whisper", () => {
  const input = props({
    value: "large",
    schema: { default: "small" },
    options: { enumOptions: [{ value: "small", label: "Small" }] },
  });
  const { rerender } = render(
    <LiveFormDataContext.Provider value={{ model: "cloud" }}>
      <AudioTranscriptionModelSizeWidget {...input} />
    </LiveFormDataContext.Provider>,
  );
  expect(screen.getByRole("combobox")).toBeDisabled();
  expect(input.onChange).toHaveBeenCalledWith(undefined);
  input.onChange = vi.fn();
  rerender(
    <LiveFormDataContext.Provider value={{ model: "whisper" }}>
      <AudioTranscriptionModelSizeWidget {...input} value={undefined} />
    </LiveFormDataContext.Provider>,
  );
  expect(screen.getByRole("combobox")).not.toBeDisabled();
  expect(input.onChange).toHaveBeenCalledWith("small");
});

it("does not dirty default or absent sizes when a provider is selected", () => {
  const input = props({ schema: { default: "small" }, value: "small" });
  const { rerender } = render(
    <LiveFormDataContext.Provider value={{ model: "cloud" }}>
      <GenAIBackedModelSizeWidget {...input} />
    </LiveFormDataContext.Provider>,
  );
  expect(input.onChange).not.toHaveBeenCalled();
  rerender(
    <LiveFormDataContext.Provider value={{ model: "cloud" }}>
      <GenAIBackedModelSizeWidget {...input} value={undefined} />
    </LiveFormDataContext.Provider>,
  );
  expect(input.onChange).not.toHaveBeenCalled();
  rerender(
    <LiveFormDataContext.Provider value={{ model: "" }}>
      <GenAIBackedModelSizeWidget {...input} schema={{}} value={undefined} />
    </LiveFormDataContext.Provider>,
  );
  expect(screen.getByRole("combobox")).not.toBeDisabled();
  expect(input.onChange).not.toHaveBeenCalled();
});
