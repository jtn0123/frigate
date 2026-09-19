import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import UsersLoadError from "./UsersLoadError";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

function httpError(status: number, message?: string) {
  return { response: { status, data: message ? { message } : {} } };
}

describe("UsersLoadError", () => {
  it("explains a 403 as an admin-only page without the generic sentence", () => {
    render(<UsersLoadError error={httpError(403)} onRetry={() => {}} />);
    expect(screen.getByText("usersLoadError.title")).toBeInTheDocument();
    expect(
      screen.getByText('usersLoadError.forbidden {"status":403}'),
    ).toBeInTheDocument();
    expect(screen.queryByText("errorState.description")).toBeNull();
    expect(screen.queryByText("HTTP 403")).toBeNull();
  });

  it("shows the generic sentence and the server detail for other failures", () => {
    render(
      <UsersLoadError
        error={httpError(500, "database locked")}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText("errorState.description")).toBeInTheDocument();
    expect(screen.getByText("database locked")).toBeInTheDocument();
  });

  it("retries through the callback", () => {
    const onRetry = vi.fn();
    render(<UsersLoadError error={httpError(500)} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "errorState.retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
