import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SetPasswordDialog from "../SetPasswordDialog";

// B45 (upstream #24846): the strength meter is gone, the confirm field shows a
// live match or mismatch line, and editing the password revalidates it, so a
// fixed mismatch no longer leaves the confirm field marked invalid.

vi.mock("swr", () => ({
  default: () => ({ data: undefined }),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string) => key,
  }),
}));
vi.mock("@/hooks/use-is-admin", () => ({
  useIsAdmin: () => false,
}));
vi.mock("@/hooks/use-doc-domain", () => ({
  useDocDomain: () => ({ getLocaleDocUrl: (path: string) => path }),
}));
vi.mock("@/components/fork/sessions/SessionsEndNotice", () => ({
  default: () => null,
}));

function renderDialog() {
  render(<SetPasswordDialog show onSave={vi.fn()} onCancel={vi.fn()} />);
  return {
    password: screen.getByPlaceholderText(
      "users.dialog.form.newPassword.placeholder",
    ),
    confirm: screen.getByPlaceholderText(
      "users.dialog.form.newPassword.confirm.placeholder",
    ),
    save: screen.getByRole("button", { name: "button.save" }),
  };
}

describe("SetPasswordDialog", () => {
  it("has no strength meter", () => {
    const { password } = renderDialog();
    fireEvent.change(password, { target: { value: "test1234" } });

    expect(
      screen.queryByText(/users\.dialog\.form\.password\.strength/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("users.dialog.form.password.requirements.title"),
    ).toBeInTheDocument();
  });

  it("shows a mismatch and clears it when the password is edited to match", async () => {
    const { password, confirm, save } = renderDialog();

    fireEvent.change(password, { target: { value: "abcdefghijkl" } });
    fireEvent.change(confirm, { target: { value: "abcdefghijkm" } });

    expect(
      await screen.findByText("users.dialog.form.password.notMatch"),
    ).toBeInTheDocument();
    await waitFor(() => expect(save).toBeDisabled());
    // FormControl marks the wrapper around the input
    const confirmControl = confirm.parentElement;
    await waitFor(() =>
      expect(confirmControl).toHaveAttribute("aria-invalid", "true"),
    );

    fireEvent.change(password, { target: { value: "abcdefghijkm" } });

    expect(
      await screen.findByText("users.dialog.form.password.match"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("users.dialog.form.password.notMatch"),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(save).toBeEnabled());
    // the confirm field is revalidated, so its stale mismatch error is gone
    await waitFor(() =>
      expect(confirmControl).toHaveAttribute("aria-invalid", "false"),
    );
  });
});
