import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type {
  ConditionalMessage,
  MessageConditionContext,
} from "@/components/config-form/section-configs/types";
import type { CameraConfig, FrigateConfig } from "@/types/frigateConfig";
import { createConfigFixture } from "./config.test-fixture";

type LevelMessages = {
  messages?: ConditionalMessage[];
  fieldMessages?: ConditionalMessage[];
};
type SectionMessages = { global?: LevelMessages; camera?: LevelMessages };

// Each test swaps in its own sections, so the evaluator runs against rules
// the test controls instead of the real section configs.
const sections: { current: Record<string, SectionMessages> } = { current: {} };

vi.mock("@/components/config-form/sectionConfigs", () => ({
  get sectionConfigs() {
    return sections.current;
  },
}));

vi.mock("@/utils/configUtil", () => ({
  getSectionConfig: (section: string, level: "global" | "camera") => {
    const entry = new Map(Object.entries(sections.current)).get(section);
    return entry?.[level] ?? {};
  },
}));

import { evaluateConfigHealth } from "../configHealth";

const t = ((key: string, options?: Record<string, unknown>) =>
  options?.["value"] === undefined
    ? key
    : `${key}:${String(options["value"])}`) as TFunction;

function message(
  key: string,
  overrides: Partial<ConditionalMessage> = {},
): ConditionalMessage {
  return {
    key,
    messageKey: `configMessages.${key}`,
    severity: "warning",
    condition: () => true,
    health: true,
    ...overrides,
  };
}

function camera(name: string, order: number): CameraConfig {
  const base = Object.values(createConfigFixture().cameras).find(
    (entry) => entry.name === "front_door",
  );
  if (!base) {
    throw new Error("config fixture has no front_door camera");
  }
  return { ...base, name, ui: { ...base.ui, order } };
}

function config(...cameras: CameraConfig[]): FrigateConfig {
  const cfg = createConfigFixture();
  cfg.cameras = Object.fromEntries(cameras.map((cam) => [cam.name, cam]));
  return cfg;
}

beforeEach(() => {
  sections.current = {};
});

describe("evaluateConfigHealth message selection", () => {
  it("returns nothing when no section flags a message for health", () => {
    sections.current = {
      detect: {
        global: {
          messages: [
            {
              key: "unflagged",
              messageKey: "configMessages.unflagged",
              severity: "info",
              condition: () => true,
            },
          ],
        },
        camera: { fieldMessages: [message("quiet", { health: false })] },
      },
      record: {},
    };
    expect(evaluateConfigHealth(config(camera("front_door", 1)), t)).toEqual(
      [],
    );
  });

  it("combines section and field messages and honors conditions and health predicates", () => {
    const seen: MessageConditionContext[] = [];
    sections.current = {
      custom: {
        global: {
          messages: [
            message("fires"),
            message("condition-off", { condition: () => false }),
          ],
          fieldMessages: [
            message("predicate-on", {
              health: (ctx) => {
                seen.push(ctx);
                return true;
              },
            }),
            message("predicate-off", { health: () => false }),
          ],
        },
      },
    };
    const cfg = Object.assign(config(), { custom: { fps: 5 } });
    const problems = evaluateConfigHealth(cfg, t);

    expect(problems.map((p) => p.id)).toEqual([
      "config:custom:fires:global",
      "config:custom:predicate-on:global",
    ]);
    expect(seen).toMatchObject([
      { level: "global", formData: { fps: 5 }, fullConfig: cfg },
    ]);
  });

  it("builds global problems with interpolated text, doc link and settings link", () => {
    sections.current = {
      detect: {
        global: {
          messages: [
            message("with-values", {
              severity: "error",
              values: { value: 42 },
              docLink: "/configuration/detect",
            }),
          ],
        },
      },
      custom: { global: { messages: [message("no-link")] } },
    };

    expect(evaluateConfigHealth(config(), t)).toEqual([
      {
        id: "config:detect:with-values:global",
        source: "config",
        severity: "error",
        scope: undefined,
        scopeIsCamera: false,
        text: "configMessages.with-values:42",
        docLink: "/configuration/detect",
        link: "/settings?page=globalDetect",
      },
      {
        id: "config:custom:no-link:global",
        source: "config",
        severity: "warning",
        scope: undefined,
        scopeIsCamera: false,
        text: "configMessages.no-link",
        docLink: undefined,
        link: undefined,
      },
    ]);
  });
});

describe("evaluateConfigHealth models section", () => {
  it("evaluates each model on its own with a scene scope", () => {
    const widths: unknown[] = [];
    sections.current = {
      models: {
        global: {
          messages: [
            message("dims", {
              condition: (ctx) => {
                widths.push(ctx.formData["width"]);
                return ctx.formData["width"] !== 320;
              },
            }),
          ],
        },
      },
    };
    const cfg = config();
    const base = cfg.models.at(0);
    if (!base) {
      throw new Error("config fixture has no model");
    }
    cfg.models = [
      { ...base, scene: "night", width: 640 },
      { ...base, scene: "all", width: 320 },
      { ...base, scene: "", width: 512 },
    ];

    expect(
      evaluateConfigHealth(cfg, t).map((p) => [p.id, p.scope, p.link]),
    ).toEqual([
      [
        "config:models:dims:model0",
        "detectionModels.scenes.night",
        "/settings?page=systemDetectorsAndModel",
      ],
      [
        "config:models:dims:model2",
        "detectionModels.scenes.all",
        "/settings?page=systemDetectorsAndModel",
      ],
    ]);
    expect(widths).toEqual([640, 320, 512]);
  });

  it("treats a models value that is not a list as one global item", () => {
    sections.current = {
      models: { global: { messages: [message("dims")] } },
    };
    const single = Object.assign(config(), { models: { width: 1 } });
    expect(evaluateConfigHealth(single, t).map((p) => p.id)).toEqual([
      "config:models:dims:global",
    ]);

    const missing = Object.assign(config(), { models: undefined });
    expect(evaluateConfigHealth(missing, t).map((p) => p.id)).toEqual([
      "config:models:dims:global",
    ]);
  });
});

describe("evaluateConfigHealth camera sections", () => {
  it("reports each active camera with its own scope and link, in UI order", () => {
    const contexts: MessageConditionContext[] = [];
    sections.current = {
      detect: {
        camera: {
          messages: [
            message("cam", {
              condition: (ctx) => {
                contexts.push(ctx);
                return true;
              },
            }),
          ],
        },
      },
    };
    const backyard = camera("backyard", 2);
    const frontDoor = Object.assign(camera("front_door", 1), {
      detect: undefined,
    });
    const disabled = { ...camera("disabled", 0), enabled: false };
    const cfg = config(backyard, frontDoor, disabled);

    expect(
      evaluateConfigHealth(cfg, t).map((p) => [
        p.id,
        p.scope,
        p.scopeIsCamera,
        p.link,
      ]),
    ).toEqual([
      [
        "config:detect:cam:camera.front_door",
        "front_door",
        true,
        "/settings?page=cameraDetect&camera=front_door",
      ],
      [
        "config:detect:cam:camera.backyard",
        "backyard",
        true,
        "/settings?page=cameraDetect&camera=backyard",
      ],
    ]);
    // a camera without the section falls back to empty form data
    expect(contexts).toMatchObject([
      { level: "camera", cameraName: "front_door", formData: {} },
      {
        level: "camera",
        cameraName: "backyard",
        formData: backyard.detect,
        fullCameraConfig: backyard,
      },
    ]);
  });

  it("skips camera rows that only repeat a problem the global row already states", () => {
    sections.current = {
      custom: {
        global: { messages: [message("shared"), message("global-only")] },
        camera: { messages: [message("shared"), message("camera-only")] },
      },
    };
    const cfg = Object.assign(
      config(
        // inherits every key the global block sets, plus its own dimensions
        Object.assign(camera("front_door", 1), {
          custom: {
            fps: 5,
            width: 1280,
            height: 720,
            stationary: { interval: 10, thresholds: [1, 2], extra: true },
          },
        }),
        // overrides a nested value, so it keeps its own row
        Object.assign(camera("backyard", 2), {
          custom: {
            fps: 5,
            stationary: { interval: 50, thresholds: [1, 2] },
          },
        }),
      ),
      {
        custom: {
          fps: 5,
          width: null,
          height: undefined,
          stationary: { interval: 10, thresholds: [1, 2] },
        },
      },
    );

    expect(evaluateConfigHealth(cfg, t).map((p) => p.id)).toEqual([
      "config:custom:shared:global",
      "config:custom:global-only:global",
      "config:custom:camera-only:camera.front_door",
      "config:custom:shared:camera.backyard",
      "config:custom:camera-only:camera.backyard",
    ]);
  });

  it("does not treat mismatched value shapes as inherited", () => {
    sections.current = {
      custom: {
        global: { messages: [message("shared")] },
        camera: { messages: [message("shared")] },
      },
    };
    const global = { stationary: { interval: 10 }, zones: ["a"] };
    const cases: [Record<string, unknown>, boolean][] = [
      // nested object on both sides and equal
      [{ stationary: { interval: 10 }, zones: ["a"] }, true],
      // camera value is null where the global value is an object
      [{ stationary: null, zones: ["a"] }, false],
      // camera value is a list where the global value is an object
      [{ stationary: [10], zones: ["a"] }, false],
      // camera value is a scalar where the global value is an object
      [{ stationary: 10, zones: ["a"] }, false],
      // lists compare by value, not by recursion
      [{ stationary: { interval: 10 }, zones: ["b"] }, false],
      // a missing key does not match a set global value
      [{ zones: ["a"] }, false],
    ];

    for (const [cameraSection, inherited] of cases) {
      const cfg = Object.assign(
        config(
          Object.assign(camera("front_door", 1), { custom: cameraSection }),
        ),
        { custom: global },
      );
      const cameraRows = evaluateConfigHealth(cfg, t).filter(
        (p) => p.scopeIsCamera,
      );
      expect(cameraRows).toHaveLength(inherited ? 0 : 1);
    }
  });

  it("keeps camera rows when the global section is missing or its message did not fire", () => {
    sections.current = {
      record: {
        global: { messages: [message("shared", { condition: () => false })] },
        camera: { messages: [message("shared")] },
      },
    };
    // no global record block at all, so every camera trivially inherits,
    // but the global message never fired
    const cfg = Object.assign(config(camera("front_door", 1)), {
      record: undefined,
    });

    expect(evaluateConfigHealth(cfg, t).map((p) => [p.id, p.link])).toEqual([
      [
        "config:record:shared:camera.front_door",
        "/settings?page=cameraRecording&camera=front_door",
      ],
    ]);
  });
});
