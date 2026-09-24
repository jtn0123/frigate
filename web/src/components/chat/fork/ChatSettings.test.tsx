import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import ChatSettings from "../ChatSettings";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

// Render the settings body inline so the test does not have to drive the
// popover or drawer open.
vi.mock("@/components/overlay/dialog/PlatformAwareDialog", () => ({
  default: ({ content }: { content: ReactNode }) => <div>{content}</div>,
}));

function renderSettings(
  alwaysAllowTools: string[],
  clearAlwaysAllowTools = vi.fn(),
) {
  render(
    <ChatSettings
      showStats="while_generating"
      setShowStats={vi.fn()}
      autoScroll
      setAutoScroll={vi.fn()}
      alwaysAllowTools={alwaysAllowTools}
      clearAlwaysAllowTools={clearAlwaysAllowTools}
    />,
  );
  return clearAlwaysAllowTools;
}

describe("ChatSettings always allowed tools (D56)", () => {
  it("lists each always allowed tool by its readable name and resets them", () => {
    const clear = renderSettings(["set_camera_state", "create_export"]);

    expect(screen.getByText("settings.always_allow.title")).toBeInTheDocument();
    expect(screen.getByText("Set Camera State")).toBeInTheDocument();
    expect(screen.getByText("Create Export")).toBeInTheDocument();
    expect(
      screen.queryByText("settings.always_allow.none"),
    ).not.toBeInTheDocument();

    const reset = screen.getByRole("button", {
      name: "settings.always_allow.reset",
    });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("shows the empty note and disables reset when nothing is allowed", () => {
    const clear = renderSettings([]);

    expect(screen.getByText("settings.always_allow.none")).toBeInTheDocument();
    const reset = screen.getByRole("button", {
      name: "settings.always_allow.reset",
    });
    expect(reset).toBeDisabled();
    fireEvent.click(reset);
    expect(clear).not.toHaveBeenCalled();
  });
});
