import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ErrorState from "./ErrorState";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

describe("ErrorState", () => {
  // UI109: inside the log panel it inherited the monospace log font
  it.each([false, true])(
    "is set in the UI font with normal wrapping (compact %s)",
    (compact) => {
      render(
        <div className="whitespace-pre-wrap font-mono">
          <ErrorState compact={compact} onRetry={() => undefined} />
        </div>,
      );
      const state = screen.getByTestId("fork-error-state");
      expect(state.className).toContain("font-sans");
      expect(state.className).toContain("whitespace-normal");
    },
  );
});
