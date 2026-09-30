import { fireEvent, render, screen } from "@testing-library/react";
import type { WidgetProps } from "@rjsf/utils";
import { beforeAll, expect, it, vi } from "vitest";
import { SelectWidget } from "../SelectWidget";

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => `t:${key}`,
    i18n: {
      exists: (key: string) => key === "detectionModels.scenes.default",
    },
  }),
}));

function open(options: WidgetProps["options"]) {
  render(
    <SelectWidget
      {...({
        id: "scene",
        name: "scene",
        label: "Scene",
        value: "default",
        schema: {},
        options: {
          enumOptions: [
            { value: "default", label: "default" },
            { value: "thermal", label: "thermal" },
          ],
          ...options,
        },
        onChange: vi.fn(),
        onBlur: vi.fn(),
        onFocus: vi.fn(),
      } as unknown as WidgetProps)}
    />,
  );
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
}

it("shows user-named values as named when their label key is optional", () => {
  open({ enumI18nPrefix: "detectionModels.scenes", enumI18nOptional: true });

  expect(
    screen.getByRole("option", { name: "t:detectionModels.scenes.default" }),
  ).toBeTruthy();
  expect(screen.getByRole("option", { name: "thermal" })).toBeTruthy();
});

it("translates every value when the label key is required", () => {
  open({ enumI18nPrefix: "detectionModels.scenes" });

  expect(
    screen.getByRole("option", { name: "t:detectionModels.scenes.thermal" }),
  ).toBeTruthy();
});
