import { fireEvent, render, screen } from "@testing-library/react";
import Form from "@rjsf/core";
import type { ReactNode } from "react";
import type {
  ObjectFieldTemplateProps,
  RJSFSchema,
  UiSchema,
} from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import { describe, expect, it, vi } from "vitest";
import type { ConfigFormContext } from "@/types/configForm";
import { LayoutGridField } from "../LayoutGridField";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: { ns?: string; count?: number }) => {
      const base = options?.ns ? `${options.ns}:${key}` : key;
      return options?.count === undefined ? base : `${base}(${options.count})`;
    },
  }),
}));

/**
 * Stand in for the Frigate theme's object template: it renders the children
 * it is given (the grid) and otherwise the plain property list, so the test
 * can tell the two apart.
 */
function TestObjectFieldTemplate(
  props: Readonly<ObjectFieldTemplateProps & { children?: ReactNode }>,
) {
  const { children, properties, fieldPathId } = props;
  return (
    <div data-testid={`object-${fieldPathId.$id}`}>
      {children ?? (
        <div data-testid="plain-properties">
          {properties.map((p) => (
            <div key={p.name}>{p.content}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const NUM = { type: "integer" } as const;

function renderForm(
  schema: RJSFSchema,
  uiSchema: UiSchema,
  formContext: ConfigFormContext = {},
  formData: Record<string, unknown> = {},
) {
  return render(
    <Form
      schema={schema}
      uiSchema={uiSchema}
      formData={formData}
      formContext={formContext}
      validator={validator}
      fields={{ LayoutGridField }}
      templates={{ ObjectFieldTemplate: TestObjectFieldTemplate }}
    >
      <></>
    </Form>,
  );
}

function input(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

/** The grid column (or leftover wrapper) that holds a field. */
function column(id: string): HTMLElement {
  let el: HTMLElement | null = input(id);
  while (el && !el.parentElement?.className.includes("grid")) {
    el = el.parentElement;
    if (el?.className.includes("col-span")) return el;
  }
  if (!el) throw new Error(`no column for #${id}`);
  return el;
}

const DETECT_SCHEMA: RJSFSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", title: "Enabled" },
    fps: { ...NUM, title: "FPS" },
    width: { ...NUM, title: "Width" },
    height: { ...NUM, title: "Height" },
    secret: { type: "string", title: "Secret" },
    extra: { type: "string", title: "Extra" },
  },
};

describe("LayoutGridField", () => {
  it("falls back to the plain object template without a layout grid", () => {
    renderForm(DETECT_SCHEMA, {
      "ui:field": "LayoutGridField",
      "ui:layoutGrid": "not-an-array",
    });
    expect(screen.getByTestId("plain-properties")).toBeInTheDocument();
    expect(input("root_fps")).toBeInTheDocument();
    expect(document.querySelector(".grid")).toBeNull();
  });

  it("lays fields out in rows with column spans and class overrides", () => {
    renderForm(DETECT_SCHEMA, {
      "ui:field": "LayoutGridField",
      "ui:options": {
        layoutGrid: { rowClassName: "grid-cols-6" },
      },
      secret: { "ui:widget": "hidden" },
      "ui:layoutGrid": [
        { "ui:row": ["enabled", "missing"], className: "row-extra" },
        {
          "ui:row": [
            { fps: { "ui:col": 4, "ui:className": "fps-col" } },
            { width: { "ui:col": "col-span-12 md:col-span-4" } },
            { height: { className: "height-col" } },
            {},
          ],
          "ui:className": "gap-6",
        },
        { "ui:row": ["missing-only"] },
      ],
    });

    expect(screen.queryByTestId("plain-properties")).toBeNull();

    const rows = document.querySelectorAll("div.grid");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveClass("gap-4", "grid-cols-6", "row-extra");
    expect(rows[1]).toHaveClass("grid-cols-6", "gap-6");

    expect(column("root_enabled")).toHaveClass("col-span-12");
    expect(column("root_fps")).toHaveClass("col-span-4", "fps-col");
    expect(column("root_width")).toHaveClass("col-span-12", "md:col-span-4");
    expect(column("root_height")).toHaveClass("col-span-12", "height-col");

    // A field missing from the layout is rendered after the rows.
    const extra = input("root_extra");
    expect(rows[1]?.contains(extra)).toBe(false);
    expect(extra.closest("div.space-y-6")).not.toBeNull();

    // Hidden fields are left out of the layout entirely.
    expect(document.querySelector("#root_secret")).toBeNull();
    expect(screen.queryByText("Secret")).toBeNull();
  });

  it("labels rows that belong to a single group once", () => {
    renderForm(
      DETECT_SCHEMA,
      {
        "ui:field": "LayoutGridField",
        "ui:groups": {
          resolution: ["fps", "width", "height"],
          misc: ["secret"],
        },
        "ui:layoutGrid": [
          { "ui:row": ["fps", "width"] },
          { "ui:row": ["height"] },
          { "ui:row": ["enabled", "fps"] },
          { "ui:row": [] },
        ],
      },
      {},
    );

    expect(screen.getAllByText("config/groups:groups.resolution")).toHaveLength(
      1,
    );
    // The grouped row is boxed.
    const label = screen.getByText("config/groups:groups.resolution");
    expect(label.parentElement).toHaveClass("rounded-lg", "border");

    // Leftover grouped field "secret" gets its own labeled box, and the
    // ungrouped leftover is indented because a grouped box exists.
    expect(screen.getByText("config/groups:groups.misc")).toBeInTheDocument();
    const extraWrapper = input("root_extra").closest("div.px-4");
    expect(extraWrapper).not.toBeNull();
    expect(extraWrapper?.parentElement).toHaveClass("pt-2");
  });

  it("uses the section prefix and domain for group labels", () => {
    renderForm(
      DETECT_SCHEMA,
      {
        "ui:field": "LayoutGridField",
        "ui:groups": { resolution: ["width", "height"] },
        "ui:layoutGrid": [{ "ui:row": ["width", "height"] }],
      },
      { i18nNamespace: "config/cameras", sectionI18nPrefix: "detect" },
    );
    expect(
      screen.getByText("config/groups:detect.cameras.resolution"),
    ).toBeInTheDocument();
  });

  it("does not label a grouped leftover whose group already has a label", () => {
    renderForm(DETECT_SCHEMA, {
      "ui:field": "LayoutGridField",
      "ui:groups": { resolution: ["fps", "width"] },
      "ui:layoutGrid": [{ "ui:row": ["fps"] }],
    });
    expect(screen.getAllByText("config/groups:groups.resolution")).toHaveLength(
      1,
    );
    // Width is a leftover in the already labeled group, boxed without a label.
    expect(input("root_width").closest("div.rounded-lg")).not.toBeNull();
  });

  it("does not indent ungrouped leftovers that are objects", () => {
    renderForm(
      {
        type: "object",
        properties: {
          a: { ...NUM, title: "A" },
          b: { ...NUM, title: "B" },
          nested: {
            type: "object",
            title: "Nested",
            properties: { c: { ...NUM, title: "C" } },
          },
        },
      },
      {
        "ui:field": "LayoutGridField",
        "ui:groups": { g: ["b"] },
        "ui:layoutGrid": [{ "ui:row": ["a"] }],
      },
    );
    expect(input("root_nested_c").closest("div.px-4")).toBeNull();
  });

  it("hides advanced fields behind a collapsible that lays them out in the grid", () => {
    renderForm(DETECT_SCHEMA, {
      "ui:field": "LayoutGridField",
      width: { "ui:options": { advanced: true } },
      height: { "ui:options": { advanced: true } },
      "ui:options": { layoutGrid: { advancedRowClassName: "grid-cols-2" } },
      "ui:layoutGrid": [{ "ui:row": ["fps", "width", "height"] }],
    });

    expect(document.getElementById("root_width")).toBeNull();
    const toggle = screen.getByRole("button", {
      name: /configForm\.advancedSettingsCount\(2\)/,
    });
    fireEvent.click(toggle);

    expect(input("root_width")).toBeInTheDocument();
    const advancedRow = input("root_width").closest("div.grid");
    expect(advancedRow).toHaveClass("grid-cols-2");
    expect(advancedRow?.contains(input("root_height"))).toBe(true);
  });

  it("stacks advanced fields when the grid is disabled for them", () => {
    renderForm(DETECT_SCHEMA, {
      "ui:field": "LayoutGridField",
      width: { "ui:options": { advanced: true } },
      "ui:options": { layoutGrid: { useGridForAdvanced: false } },
      "ui:layoutGrid": [{ "ui:row": ["fps", "width"] }],
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: /configForm\.advancedSettingsCount\(1\)/,
      }),
    );
    expect(input("root_width").closest("div.grid")).toBeNull();
  });

  it("opens the advanced section when an advanced field is overridden", () => {
    renderForm(
      DETECT_SCHEMA,
      {
        "ui:field": "LayoutGridField",
        width: { "ui:options": { advanced: true } },
        "ui:layoutGrid": [{ "ui:row": ["fps", "width"] }],
      },
      { overrides: { width: 1280 } },
      { width: 1280 },
    );
    expect(input("root_width")).toHaveValue(1280);
  });

  it("renders the grid inside the object template for a nested object", () => {
    renderForm(
      {
        type: "object",
        properties: {
          motion: {
            type: "object",
            title: "Motion",
            properties: {
              threshold: { ...NUM, title: "Threshold" },
              contour: { ...NUM, title: "Contour" },
              lightning: { ...NUM, title: "Lightning" },
            },
          },
        },
      },
      {
        motion: {
          "ui:field": "LayoutGridField",
          lightning: { "ui:options": { advanced: true } },
          "ui:layoutGrid": [
            { "ui:row": [{ threshold: { "ui:col": 6 } }, "contour"] },
          ],
        },
      },
    );

    const nested = screen.getByTestId("object-root_motion");
    expect(nested.querySelector("div.grid")).not.toBeNull();
    expect(column("root_motion_threshold")).toHaveClass("col-span-6");
    expect(
      screen.getByRole("button", {
        name: /configForm\.advancedCount\(1\)/,
      }),
    ).toBeInTheDocument();
  });

  it("offers an add button for objects with additional properties", () => {
    renderForm(
      {
        type: "object",
        properties: { fps: { ...NUM, title: "FPS" } },
        additionalProperties: { type: "string" },
      },
      {
        "ui:field": "LayoutGridField",
        "ui:options": { addButtonText: "Add stream" },
        "ui:layoutGrid": [{ "ui:row": ["fps"] }],
      },
    );
    const add = screen.getByRole("button", { name: "Add stream" });
    fireEvent.click(add);
    expect(document.querySelectorAll("input").length).toBeGreaterThan(1);
  });
});
