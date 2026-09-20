import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import ActivityIndicator from "../activity-indicator";

// the label comes from the fork namespace now, so the key stands in for it
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

it("is a named status, so screen readers announce loading", () => {
  render(<ActivityIndicator />);
  expect(
    screen.getByRole("status", { name: "a11yLabels.loading" }),
  ).toBeTruthy();
});
