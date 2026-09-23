import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CommandPaletteGate from "./CommandPaletteGate";

const gate = vi.hoisted(() => ({
  enabled: true,
  open: false,
  shortcuts: vi.fn(),
}));

vi.mock("@/fork/flags", () => ({
  isForkEnabled: () => gate.enabled,
}));
vi.mock("@/hooks/fork/use-command-palette", () => ({
  useCommandPaletteOpen: () => [gate.open, vi.fn()],
  useCommandPaletteShortcuts: () => {
    gate.shortcuts();
  },
}));
vi.mock("./CommandPalette", () => ({
  default: () => <div data-testid="loaded-palette" />,
}));

describe("CommandPaletteGate", () => {
  beforeEach(() => {
    gate.enabled = true;
    gate.open = false;
    gate.shortcuts.mockClear();
  });

  it("keeps shortcuts active while closed and loads the palette on first open", async () => {
    const view = render(<CommandPaletteGate />);
    expect(gate.shortcuts).toHaveBeenCalled();
    expect(screen.queryByTestId("loaded-palette")).toBeNull();

    gate.open = true;
    view.rerender(<CommandPaletteGate />);
    expect(await screen.findByTestId("loaded-palette")).toBeInTheDocument();

    gate.open = false;
    view.rerender(<CommandPaletteGate />);
    expect(screen.getByTestId("loaded-palette")).toBeInTheDocument();
  });

  it("does not mount the palette when its fork flag is disabled", () => {
    gate.enabled = false;
    gate.open = true;
    render(<CommandPaletteGate />);
    expect(screen.queryByTestId("loaded-palette")).toBeNull();
  });
});
