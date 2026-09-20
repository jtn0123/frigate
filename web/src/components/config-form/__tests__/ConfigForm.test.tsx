/**
 * The schema validator is fetched beside the form rather than inside its chunk
 * (G8). Nothing may be editable before it resolves, so validation keeps the
 * behaviour it had when the import was static.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", t: (key: string) => key },
  }),
}));

vi.mock("@rjsf/validator-ajv8", () => ({
  default: { validateFormData: vi.fn(), isValid: vi.fn() },
}));

vi.mock("@rjsf/shadcn", () => ({
  default: (props: { schema: { title?: string } }) => (
    <div data-testid="rjsf-form">{props.schema.title ?? "form"}</div>
  ),
}));

import ConfigForm from "../ConfigForm";

const SCHEMA = {
  title: "Detect",
  type: "object" as const,
  properties: { enabled: { type: "boolean" as const, title: "Enabled" } },
};

describe("ConfigForm", () => {
  it("shows the loading indicator before the validator resolves", () => {
    render(<ConfigForm schema={SCHEMA} />);
    expect(screen.getByLabelText("a11yLabels.loading")).toBeTruthy();
    expect(screen.queryByTestId("rjsf-form")).toBeNull();
  });

  it("renders the form once the validator has loaded", async () => {
    render(<ConfigForm schema={SCHEMA} />);
    await waitFor(() => expect(screen.getByTestId("rjsf-form")).toBeTruthy());
    expect(screen.queryByLabelText("a11yLabels.loading")).toBeNull();
  });

  it("unmounting while the import is in flight leaves nothing behind", async () => {
    const { unmount } = render(<ConfigForm schema={SCHEMA} />);
    unmount();
    // The effect's cleanup drops the result, so the resolved import cannot
    // render into a container that is gone.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("rjsf-form")).toBeNull();
    expect(screen.queryByLabelText("a11yLabels.loading")).toBeNull();
  });
});
