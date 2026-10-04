import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthState } from "@/context/auth-state";
import SessionsEndNotice from "./SessionsEndNotice";

const mocks = vi.hoisted(() => ({
  isForkEnabled: vi.fn<(flag: string) => boolean>(),
}));

vi.mock("@/fork/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/fork/flags")>()),
  isForkEnabled: mocks.isForkEnabled,
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options === undefined ? key : `${key} ${JSON.stringify(options)}`,
  }),
}));

const AUTH: AuthState = {
  user: { username: "admin", role: "admin" },
  allowedCameras: [],
  isLoading: false,
  isAuthenticated: true,
};

function renderNotice(change: "password" | "role", username?: string) {
  return render(
    <AuthContext.Provider
      value={{ auth: AUTH, login: () => undefined, logout: () => undefined }}
    >
      <SessionsEndNotice change={change} username={username} />
    </AuthContext.Provider>,
  );
}

describe("SessionsEndNotice", () => {
  beforeEach(() => {
    mocks.isForkEnabled.mockReturnValue(true);
  });

  it("keeps this device signed in on an own password change", () => {
    renderNotice("password", "admin");
    expect(screen.getByTestId("sessions-end-notice")).toHaveTextContent(
      "sessions.endNotice.ownPassword",
    );
  });

  it("does not assume whose password Settings > Users is setting", () => {
    // that dialog is opened without a username, for any account
    renderNotice("password");
    const notice = screen.getByTestId("sessions-end-notice");
    expect(notice).toHaveTextContent("sessions.endNotice.anyPassword");
    expect(notice).not.toHaveTextContent("sessions.endNotice.ownPassword");
  });

  it("names the user signed out by a password change", () => {
    renderNotice("password", "bob");
    expect(screen.getByTestId("sessions-end-notice")).toHaveTextContent(
      'sessions.endNotice.password {"user":"bob"}',
    );
  });

  it("names the user who signs in again after a role change", () => {
    renderNotice("role", "bob");
    expect(screen.getByTestId("sessions-end-notice")).toHaveTextContent(
      'sessions.endNotice.role {"user":"bob"}',
    );
  });

  it("shows nothing with the sessions feature off", () => {
    mocks.isForkEnabled.mockReturnValue(false);
    renderNotice("role", "bob");
    expect(screen.queryByTestId("sessions-end-notice")).toBeNull();
  });
});
