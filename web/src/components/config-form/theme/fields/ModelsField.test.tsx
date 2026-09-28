import { fireEvent, render, screen, within } from "@testing-library/react";
import type { FieldProps, RJSFSchema } from "@rjsf/utils";
import { useState } from "react";
import { beforeAll, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModelsField } from "./ModelsField";

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
  Trans: ({ children }: { children: string }) => children,
}));

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key === "config") {
      return { data: { plus: { enabled: true } }, isLoading: false };
    }
    if (key === "/plus/models") {
      return { data: {}, isLoading: false };
    }
    return { data: [], isLoading: false };
  },
}));

const SCHEMA: RJSFSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      scene: {
        type: "string",
        enum: ["all", "indoor", "outdoor", "indoor_thermal", "outdoor_thermal"],
      },
      path: { type: "string" },
      width: { type: "integer" },
    },
  },
};

function StubSchemaField({ name }: Readonly<{ name: string }>) {
  return <div data-testid={`field-${name}`} />;
}

type Model = { scene?: string; path?: string; devices?: string[] };

function Harness({
  initial,
  fullConfig,
  onSaved,
}: Readonly<{
  initial: Model[];
  fullConfig: Record<string, unknown>;
  onSaved?: (models: Model[]) => void;
}>) {
  const [formData, setFormData] = useState<Model[]>(initial);
  const props: unknown = {
    schema: SCHEMA,
    uiSchema: {},
    formData,
    onChange: (next: Model[]) => {
      setFormData(next);
      onSaved?.(next);
    },
    fieldPathId: { path: ["models"], $id: "root_models" },
    idSchema: { $id: "root_models" },
    errorSchema: {},
    registry: {
      fields: { SchemaField: StubSchemaField },
      globalFormOptions: { idPrefix: "root", idSeparator: "_" },
      formContext: { fullConfig },
    },
  };

  return (
    <TooltipProvider>
      <ModelsField {...(props as FieldProps)} />
    </TooltipProvider>
  );
}

const cameras = (scenes: (string | undefined)[]) =>
  Object.fromEntries(
    scenes.map((scene, index) => [
      `cam${index}`,
      { detect: scene ? { scene } : {} },
    ]),
  );

function cardCountText(): string[] {
  return screen
    .getAllByText(/detectionModels\.cameras:\d+$/)
    .map(
      (node) =>
        /detectionModels\.cameras:\d+$/.exec(node.textContent ?? "")?.[0] ?? "",
    );
}

it("keeps a custom model on the custom tab after the Frigate+ model before it is deleted", () => {
  const onSaved = vi.fn();
  render(
    <Harness
      initial={[
        { scene: "all", path: "/config/model_cache/plus/abc", devices: [] },
        { scene: "indoor", path: "/config/custom.onnx", devices: [] },
      ]}
      fullConfig={{
        models: [{ scene: "all", plus: { id: "abc" } }, { scene: "indoor" }],
        cameras: {},
      }}
      onSaved={onSaved}
    />,
  );

  // the Frigate+ model opens on its tab, the custom model on its fields
  expect(screen.getAllByTestId("field-path")).toHaveLength(1);
  expect(
    screen.getAllByText("detectionModels.plusModel.noModelSelected"),
  ).toHaveLength(1);

  fireEvent.click(screen.getAllByRole("button", { name: "button.delete" })[0]);

  // the saved payload is only the remaining model, with no identity field
  expect(onSaved).toHaveBeenLastCalledWith([
    { scene: "indoor", path: "/config/custom.onnx", devices: [] },
  ]);
  expect(screen.getByTestId("field-path")).toBeInTheDocument();
  expect(screen.getByTestId("field-width")).toBeInTheDocument();
  expect(
    screen.queryByText("detectionModels.plusModel.noModelSelected"),
  ).not.toBeInTheDocument();
});

it("gives a model added after a delete its own card", () => {
  const onSaved = vi.fn();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <Harness
      initial={[
        { scene: "all", devices: [] },
        { scene: "indoor", devices: [] },
      ]}
      fullConfig={{ cameras: {} }}
      onSaved={onSaved}
    />,
  );

  fireEvent.click(screen.getAllByRole("button", { name: "button.delete" })[1]);
  fireEvent.click(
    screen.getByRole("button", { name: /detectionModels\.addModel/ }),
  );

  expect(onSaved).toHaveBeenLastCalledWith([
    { scene: "all", devices: [] },
    expect.objectContaining({ scene: "indoor", devices: [] }),
  ]);
  expect(screen.getAllByRole("button", { name: "button.delete" })).toHaveLength(
    2,
  );
  // a reused key would make React warn about duplicate children
  expect(
    consoleError.mock.calls
      .flat()
      .some((arg) => String(arg).includes("same key")),
  ).toBe(false);
  consoleError.mockRestore();
});

it("counts cameras whose scene matches a model exactly", () => {
  render(
    <Harness
      initial={[
        { scene: "all", devices: [] },
        { scene: "indoor", devices: [] },
      ]}
      fullConfig={{
        cameras: cameras(["indoor", "indoor", undefined, "all"]),
      }}
    />,
  );

  expect(cardCountText()).toEqual([
    "detectionModels.cameras:2",
    "detectionModels.cameras:2",
  ]);
});

it("counts cameras whose scene has no model toward the all model", () => {
  render(
    <Harness
      initial={[
        { scene: "all", devices: [] },
        { scene: "indoor", devices: [] },
      ]}
      fullConfig={{
        cameras: cameras(["outdoor", "outdoor", "indoor", undefined]),
      }}
    />,
  );

  const [allCard, indoorCard] = cardCountText();
  expect(allCard).toBe("detectionModels.cameras:3");
  expect(indoorCard).toBe("detectionModels.cameras:1");
});

it("treats a model without a scene as the all model", () => {
  render(
    <Harness
      initial={[{ devices: [] }]}
      fullConfig={{
        cameras: cameras(["outdoor", undefined]),
      }}
    />,
  );

  expect(cardCountText()).toEqual(["detectionModels.cameras:2"]);
});

it("attributes unmatched cameras to no model when there is no all model", () => {
  render(
    <Harness
      initial={[
        { scene: "indoor", devices: [] },
        { scene: "outdoor", devices: [] },
      ]}
      fullConfig={{
        cameras: cameras(["indoor", "indoor_thermal", undefined]),
      }}
    />,
  );

  const counts = cardCountText();
  expect(counts).toEqual([
    "detectionModels.cameras:1",
    "detectionModels.cameras:0",
  ]);
  expect(within(document.body).queryByText(/cameras:3/)).toBeNull();
});
