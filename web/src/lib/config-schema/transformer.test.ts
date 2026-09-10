import { describe, expect, it } from "vitest";
import type { RJSFSchema } from "@rjsf/utils";
import {
  applySchemaDefaults,
  extractSchemaSection,
  resolveAndCleanSchema,
  resolveSchemaRefs,
  transformSchema,
} from "./transformer";

type S = Record<string, unknown>;

const root: RJSFSchema = {
  $defs: {
    Retain: {
      type: "object",
      properties: {
        days: { type: "integer", default: 7 },
        mode: { type: "string", enum: ["all", "motion"], default: "all" },
      },
      required: ["days"],
    },
    Record: {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: false },
        retain: { $ref: "#/$defs/Retain" },
        password: { type: "string" },
      },
    },
  },
  properties: {
    record: { $ref: "#/$defs/Record", description: "Recording" },
    cameras: {
      type: "object",
      additionalProperties: { $ref: "#/$defs/Record" },
    },
  },
};

describe("resolveSchemaRefs", () => {
  it("inlines $defs references and keeps sibling keywords", () => {
    const resolved = resolveSchemaRefs(root) as S;
    const record = (resolved.properties as S).record as S;
    expect(record.$ref).toBeUndefined();
    expect(record.description).toBe("Recording");
    expect(record.type).toBe("object");
    const retain = (record.properties as S).retain as S;
    expect((retain.properties as S).days).toEqual({
      type: "integer",
      default: 7,
    });
  });

  it("supports the legacy definitions keyword", () => {
    const schema: RJSFSchema = {
      definitions: { Leaf: { type: "string" } },
      properties: { a: { $ref: "#/definitions/Leaf" } },
    };
    const resolved = resolveSchemaRefs(schema) as S;
    expect((resolved.properties as S).a).toEqual({ type: "string" });
  });

  it("leaves unknown references untouched", () => {
    const schema: RJSFSchema = {
      properties: { a: { $ref: "#/$defs/Missing" } },
    };
    const resolved = resolveSchemaRefs(schema) as S;
    expect((resolved.properties as S).a).toEqual({ $ref: "#/$defs/Missing" });
  });

  it("merges allOf branches, their properties and required lists", () => {
    const schema: RJSFSchema = {
      $defs: {
        Base: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      },
      allOf: [
        { $ref: "#/$defs/Base" },
        { properties: { b: { type: "integer" } }, required: ["b"] },
      ],
      title: "Merged",
    };
    const resolved = resolveSchemaRefs(schema) as S;
    expect(resolved.allOf).toBeUndefined();
    expect(resolved.title).toBe("Merged");
    expect(Object.keys(resolved.properties as S)).toEqual(["a", "b"]);
    expect(resolved.required).toEqual(["a", "b"]);
  });

  it("recurses into anyOf, oneOf, items and additionalProperties", () => {
    const schema: RJSFSchema = {
      $defs: { Leaf: { type: "string" } },
      properties: {
        any: { anyOf: [{ $ref: "#/$defs/Leaf" }, { type: "null" }] },
        one: { oneOf: [{ $ref: "#/$defs/Leaf" }] },
        list: { type: "array", items: { $ref: "#/$defs/Leaf" } },
        tuple: { type: "array", items: [{ $ref: "#/$defs/Leaf" }] },
        dict: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/Leaf" },
        },
      },
    };
    const props = (resolveSchemaRefs(schema) as S).properties as S;
    expect((props.any as S).anyOf).toEqual([
      { type: "string" },
      { type: "null" },
    ]);
    expect((props.one as S).oneOf).toEqual([{ type: "string" }]);
    expect((props.list as S).items).toEqual({ type: "string" });
    expect((props.tuple as S).items).toEqual([{ type: "string" }]);
    expect((props.dict as S).additionalProperties).toEqual({ type: "string" });
  });

  it("returns a schema without refs structurally unchanged", () => {
    const plain: RJSFSchema = { type: "string", title: "T" };
    expect(resolveSchemaRefs(plain)).toEqual(plain);
  });
});

describe("resolveAndCleanSchema", () => {
  it("drops $defs and definitions after resolving", () => {
    const cleaned = resolveAndCleanSchema({
      ...root,
      definitions: { X: { type: "string" } },
    }) as S;
    expect(cleaned.$defs).toBeUndefined();
    expect(cleaned.definitions).toBeUndefined();
    expect((cleaned.properties as S).record).toBeDefined();
  });
});

describe("transformSchema nullable normalisation", () => {
  it("unwraps anyOf [T, null] into a type array", () => {
    const { schema } = transformSchema({
      properties: {
        fps: {
          anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
          default: null,
          title: "FPS",
        },
      },
    });
    const fps = ((schema as S).properties as S).fps as S;
    expect(fps.anyOf).toBeUndefined();
    expect(fps.type).toEqual(["integer", "null"]);
    expect(fps.minimum).toBe(1);
    expect(fps.title).toBe("FPS");
  });

  it("appends null to enums when unwrapping a nullable enum", () => {
    const { schema } = transformSchema({
      properties: {
        mode: {
          oneOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }],
        },
      },
    });
    const mode = ((schema as S).properties as S).mode as S;
    expect(mode.type).toEqual(["string", "null"]);
    expect(mode.enum).toEqual(["a", "b", null]);
  });

  it("adds null to the type when the default is null", () => {
    const { schema } = transformSchema({
      properties: { name: { type: "string", default: null } },
    });
    expect((((schema as S).properties as S).name as S).type).toEqual([
      "string",
      "null",
    ]);
  });

  it("collapses a string enum unioned with a plain string into examples", () => {
    const { schema } = transformSchema({
      properties: {
        preset: {
          anyOf: [
            { type: "string", enum: ["fast", "slow"] },
            { type: "string" },
            { type: "null" },
          ],
        },
      },
    });
    const preset = ((schema as S).properties as S).preset as S;
    expect(preset.anyOf).toBeUndefined();
    expect(preset.type).toEqual(["string", "null"]);
    expect(preset.examples).toEqual(["fast", "slow"]);
  });

  it("keeps multi-branch unions and normalises each branch", () => {
    const { schema } = transformSchema({
      properties: {
        value: {
          anyOf: [{ type: "integer" }, { type: "boolean" }, { type: "null" }],
        },
      },
    });
    const value = ((schema as S).properties as S).value as S;
    expect(Array.isArray(value.anyOf)).toBe(true);
    expect((value.anyOf as unknown[]).length).toBe(3);
  });
});

describe("transformSchema hidden fields", () => {
  it("removes hidden properties from the schema and required list", () => {
    const { schema, uiSchema } = transformSchema(
      {
        type: "object",
        properties: {
          keep: { type: "string" },
          raw_mask: { type: "string" },
          nested: {
            type: "object",
            properties: {
              secret_thing: { type: "string" },
              x: { type: "integer" },
            },
          },
        },
        required: ["keep", "raw_mask"],
      },
      { hiddenFields: ["raw_mask", "nested.secret_thing"] },
    );
    const props = (schema as S).properties as S;
    expect(props.raw_mask).toBeUndefined();
    expect((schema as S).required).toEqual(["keep"]);
    expect(Object.keys(((props.nested as S).properties as S) ?? {})).toEqual([
      "x",
    ]);
    expect(uiSchema.raw_mask).toBeUndefined();
  });

  it("descends through additionalProperties for wildcard patterns", () => {
    const { schema } = transformSchema(
      {
        type: "object",
        properties: {
          filters: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                mask: { type: "string" },
                min_area: { type: "integer" },
              },
            },
          },
        },
      },
      { hiddenFields: ["filters.*.mask"] },
    );
    const filters = ((schema as S).properties as S).filters as S;
    const entry = filters.additionalProperties as S;
    expect(Object.keys(entry.properties as S)).toEqual(["min_area"]);
  });
});

describe("transformSchema uiSchema generation", () => {
  it("picks widgets by field name and schema shape", () => {
    const { uiSchema } = transformSchema({
      type: "object",
      properties: {
        password: { type: "string" },
        api_secret: { type: "string" },
        box_color: { type: "object", properties: {} },
        mode: { type: "string", enum: ["a", "b"] },
        enabled: { type: "boolean" },
        threshold: { type: "number", minimum: 0, maximum: 1 },
        count: { type: "integer" },
        labels: { type: "array", items: { type: "string" } },
        numbers: { type: "array", items: { type: "integer" } },
      },
    });
    expect(uiSchema.password["ui:widget"]).toBe("password");
    expect(uiSchema.api_secret["ui:widget"]).toBe("password");
    expect(uiSchema.box_color["ui:widget"]).toBe("color");
    expect(uiSchema.mode["ui:widget"]).toBe("select");
    expect(uiSchema.enabled["ui:widget"]).toBe("switch");
    expect(uiSchema.threshold["ui:widget"]).toBe("range");
    expect(uiSchema.labels["ui:widget"]).toBe("tags");
    expect(uiSchema.count).toBeUndefined();
    expect(uiSchema.numbers).toBeUndefined();
  });

  it("prefers explicit widget mappings", () => {
    const { uiSchema } = transformSchema(
      { properties: { enabled: { type: "boolean" } } },
      { widgetMappings: { enabled: "customToggle" } },
    );
    expect(uiSchema.enabled["ui:widget"]).toBe("customToggle");
  });

  it("orders fields with dotted paths at each depth", () => {
    const { uiSchema } = transformSchema(
      {
        properties: {
          a: { type: "string" },
          genai: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              enabled: { type: "boolean" },
            },
          },
        },
      },
      { fieldOrder: ["genai", "a", "genai.enabled"] },
    );
    expect(uiSchema["ui:order"]).toEqual(["genai", "a", "*"]);
    expect(uiSchema.genai["ui:order"]).toEqual(["enabled", "*"]);
  });

  it("marks advanced fields, including wildcard matches under dicts", () => {
    const { uiSchema } = transformSchema(
      {
        properties: {
          debug: { type: "boolean" },
          filters: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: { min_ratio: { type: "number" } },
            },
          },
        },
      },
      { advancedFields: ["debug", "filters.*.min_ratio"] },
    );
    expect(uiSchema.debug["ui:options"]).toEqual({ advanced: true });
    expect(
      uiSchema.filters.additionalProperties.min_ratio["ui:options"].advanced,
    ).toBe(true);
  });

  it("blanks descriptions when includeDescriptions is false", () => {
    const { uiSchema } = transformSchema(
      {
        properties: {
          a: { type: "string", description: "d" },
          b: { type: "string" },
        },
      },
      { includeDescriptions: false },
    );
    expect(uiSchema.a["ui:description"]).toBe("");
    expect(uiSchema.b).toBeUndefined();
  });
});

describe("extractSchemaSection", () => {
  it("walks dotted paths, resolves refs and strips $defs", () => {
    const section = extractSchemaSection(root, "record.retain") as S;
    expect(section.$defs).toBeUndefined();
    expect((section.properties as S).days).toEqual({
      type: "integer",
      default: 7,
    });
  });

  it("returns null for unknown paths and unresolvable refs", () => {
    expect(extractSchemaSection(root, "nope")).toBeNull();
    expect(extractSchemaSection(root, "record.nope")).toBeNull();
    expect(
      extractSchemaSection(
        { properties: { a: { $ref: "#/$defs/Gone" } } },
        "a",
      ),
    ).toBeNull();
  });
});

describe("applySchemaDefaults", () => {
  const schema: RJSFSchema = {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: false },
      nullable: { type: "string", default: null },
      retain: {
        type: "object",
        properties: { days: { type: "integer", default: 7 } },
      },
    },
  };

  it("fills defaults without mutating the input", () => {
    const input = {};
    const result = applySchemaDefaults(schema, input);
    expect(result).toEqual({ enabled: false });
    expect(input).toEqual({});
  });

  it("keeps existing values and skips null defaults", () => {
    expect(applySchemaDefaults(schema, { enabled: true })).toEqual({
      enabled: true,
    });
  });

  it("recurses into nested objects only when present in form data", () => {
    expect(applySchemaDefaults(schema, { retain: {} })).toEqual({
      enabled: false,
      retain: { days: 7 },
    });
  });

  it("uses the non-null object branch of anyOf schemas", () => {
    const nullable: RJSFSchema = {
      anyOf: [
        { type: "null" },
        { type: "object", properties: { a: { type: "integer", default: 1 } } },
      ],
    };
    expect(applySchemaDefaults(nullable)).toEqual({ a: 1 });
  });

  it("returns the form data unchanged when there are no properties", () => {
    expect(applySchemaDefaults({ type: "string" }, { x: 1 })).toEqual({ x: 1 });
  });
});
