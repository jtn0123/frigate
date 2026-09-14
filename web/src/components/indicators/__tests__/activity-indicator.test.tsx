import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import ActivityIndicator from "../activity-indicator";

it("is a named status, so screen readers announce loading", () => {
  render(<ActivityIndicator />);
  expect(screen.getByRole("status", { name: "Loading…" })).toBeTruthy();
});
