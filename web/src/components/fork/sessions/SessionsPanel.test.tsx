import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthState } from "@/context/auth-state";
import type { SessionItem } from "@/hooks/fork/use-sessions";
import SessionsPanel, { VISIBLE_SESSIONS } from "./SessionsPanel";

const mocks = vi.hoisted(() => ({
  sessions: {
    data: undefined as SessionItem[] | undefined,
    error: undefined as unknown,
    isLoading: false,
  },
  mutate: vi.fn<(update?: unknown, options?: unknown) => Promise<unknown>>(),
  del: vi.fn<(url: string) => Promise<unknown>>(),
  post: vi.fn<(url: string, body: unknown) => Promise<unknown>>(),
  toastSuccess: vi.fn<(message: string) => void>(),
  toastError: vi.fn<(message: string) => void>(),
}));

vi.mock("@/api/fork/client", () => ({
  useApi: (path: string | null) => ({
    ...(path === null ? { data: undefined } : mocks.sessions),
    mutate: mocks.mutate,
  }),
}));
vi.mock("swr", () => ({
  default: () => ({ data: { ui: { timezone: "UTC", time_format: "24hour" } } }),
}));
vi.mock("axios", () => ({
  default: {
    delete: (url: string) => mocks.del(url),
    post: (url: string, body: unknown) => mocks.post(url, body),
    isAxiosError: (error: unknown) =>
      typeof error === "object" && error !== null && "response" in error,
  },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (message: string) => mocks.toastSuccess(message),
    error: (message: string) => mocks.toastError(message),
  },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) => {
      const { ns: _ns, ...values } = options ?? {};
      return Object.keys(values).length === 0
        ? key
        : `${key} ${JSON.stringify(values)}`;
    },
  }),
}));

const NOW = Date.now() / 1000;
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function session(
  id: string,
  username: string,
  userAgent: string,
  current = false,
): SessionItem {
  return {
    id,
    username,
    created_at: NOW - 7200,
    last_seen: NOW - 30,
    expires_at: NOW + 86400,
    user_agent: userAgent,
    ip: "192.168.1.20",
    current,
  };
}

const SESSIONS = [
  session("mine", "admin", CHROME_MAC, true),
  session("phone", "admin", SAFARI_IPHONE),
  session("bob-1", "bob", "HomeAssistant/2024.10.1 aiohttp/3.10.5"),
  session("bob-2", "bob", ""),
];

const AUTH: AuthState = {
  user: { username: "admin", role: "admin" },
  allowedCameras: [],
  isLoading: false,
  isAuthenticated: true,
};

function renderPanel(props: ComponentProps<typeof SessionsPanel> = {}) {
  return render(
    <AuthContext.Provider
      value={{ auth: AUTH, login: () => undefined, logout: () => undefined }}
    >
      <SessionsPanel {...props} />
    </AuthContext.Provider>,
  );
}

/** admin signed in here and on seven phones, as a script that logs in often. */
function manyAdminSessions(): SessionItem[] {
  const phones = Array.from({ length: 7 }, (_, index) =>
    session(`phone-${index}`, "admin", SAFARI_IPHONE),
  );
  // this device is listed last by the server and still shows first
  return [...phones, session("mine", "admin", CHROME_MAC, true)];
}

/** Elements by index; fails the test, instead of asserting, when missing. */
function at(elements: HTMLElement[], index: number): HTMLElement {
  const element = elements.at(index);
  if (element === undefined) {
    throw new Error(`no element at ${index}`);
  }
  return element;
}

function firstRevoke() {
  return at(
    screen.getAllByRole("button", { name: /sessions\.revokeLabel/ }),
    0,
  );
}

function confirm() {
  const dialog = screen.getByTestId("confirm-clear-dialog");
  // the confirming action is last, after Cancel
  fireEvent.click(at(within(dialog).getAllByRole("button"), -1));
}

beforeEach(() => {
  mocks.sessions.data = SESSIONS;
  mocks.sessions.error = undefined;
  mocks.sessions.isLoading = false;
  mocks.mutate.mockReset().mockResolvedValue(undefined);
  mocks.del.mockReset().mockResolvedValue({ status: 200 });
  mocks.post.mockReset().mockResolvedValue({ data: { revoked: 1 } });
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

describe("SessionsPanel", () => {
  it("groups everyone's sessions, the signed-in user first", () => {
    renderPanel();

    const groups = screen.getAllByTestId("session-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent("admin");
    expect(groups[0]).toHaveTextContent("sessions.you");
    expect(groups[1]).toHaveTextContent("Home Assistant");
    expect(groups[1]).toHaveTextContent("sessions.device.unknown");

    const rows = within(at(groups, 0)).getAllByTestId("session-row");
    expect(at(rows, 0)).toHaveTextContent("sessions.thisDevice");
    // the session in use here cannot be revoked from the list
    expect(within(at(rows, 0)).queryByRole("button")).toBeNull();
    expect(within(at(rows, 1)).getByRole("button")).toHaveTextContent(
      "sessions.revoke",
    );
  });

  it("revokes a session after confirming", async () => {
    renderPanel();

    fireEvent.click(firstRevoke());
    expect(mocks.del).not.toHaveBeenCalled();
    confirm();

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("sessions.revoked"),
    );
    expect(mocks.del).toHaveBeenCalledWith("fork/sessions/phone");
    expect(mocks.mutate).toHaveBeenCalled();
  });

  it("counts a session that is already gone as revoked", async () => {
    mocks.del.mockRejectedValue({ response: { status: 404 } });
    renderPanel();

    fireEvent.click(firstRevoke());
    confirm();

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("sessions.revoked"),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("says so when a revoke fails", async () => {
    mocks.del.mockRejectedValue({ response: { status: 500 } });
    renderPanel();

    fireEvent.click(firstRevoke());
    confirm();

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("sessions.revokeFailed"),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("signs out the caller's other sessions, keeping this one", async () => {
    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "sessions.signOutOthers" }),
    );
    expect(screen.getByTestId("confirm-clear-dialog")).toHaveTextContent(
      'sessions.othersDescription {"count":1}',
    );
    confirm();

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        'sessions.signedOut {"count":1}',
      ),
    );
    expect(mocks.post).toHaveBeenCalledWith("fork/sessions/revoke_all", {
      username: "admin",
      keep_current: true,
    });
  });

  it("signs another user out everywhere", async () => {
    mocks.post.mockResolvedValue({ data: { revoked: 0 } });
    renderPanel();

    fireEvent.click(
      screen.getByRole("button", {
        name: 'sessions.signOutEverywhereLabel {"user":"bob"}',
      }),
    );
    confirm();

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("sessions.signedOutNone"),
    );
    expect(mocks.post).toHaveBeenCalledWith("fork/sessions/revoke_all", {
      username: "bob",
      keep_current: false,
    });
  });

  it("says so when signing out fails", async () => {
    mocks.post.mockRejectedValue(new Error("offline"));
    renderPanel();

    fireEvent.click(
      screen.getByRole("button", {
        name: 'sessions.signOutEverywhereLabel {"user":"bob"}',
      }),
    );
    confirm();

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("sessions.signOutFailed"),
    );
  });

  it("lists only one user's sessions without group headers", () => {
    renderPanel({ user: "admin" });

    expect(screen.queryAllByTestId("session-group")).toHaveLength(0);
    expect(screen.getAllByTestId("session-row")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "sessions.signOutOthers" }),
    ).toBeInTheDocument();
  });

  it("offers no sign-out when this is the only session", () => {
    mocks.sessions.data = [session("mine", "admin", CHROME_MAC, true)];
    renderPanel({ user: "admin" });

    expect(screen.getAllByTestId("session-row")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "sessions.signOutOthers" }),
    ).toBeNull();
  });

  it("explains an empty list", () => {
    mocks.sessions.data = [];
    const { unmount } = renderPanel();
    expect(screen.getByText("sessions.empty")).toBeInTheDocument();
    unmount();

    renderPanel({ user: "admin" });
    expect(screen.getByText("sessions.emptyMine")).toBeInTheDocument();
  });

  it("shows loading, then a failed read with a retry", () => {
    mocks.sessions.data = undefined;
    mocks.sessions.isLoading = true;
    const { rerender } = renderPanel();
    expect(screen.getByText("sessions.loading")).toBeInTheDocument();

    mocks.sessions.isLoading = false;
    mocks.sessions.error = new Error("500");
    rerender(
      <AuthContext.Provider
        value={{ auth: AUTH, login: () => undefined, logout: () => undefined }}
      >
        <SessionsPanel />
      </AuthContext.Provider>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("sessions.loadFailed");
    fireEvent.click(within(alert).getByRole("button"));
    expect(mocks.mutate).toHaveBeenCalled();
  });

  it("folds a long group behind Show more, this device first", () => {
    mocks.sessions.data = manyAdminSessions();
    renderPanel();

    const group = screen.getByTestId("session-group");
    // the count in the header is the whole group
    expect(group).toHaveTextContent('sessions.count {"count":8}');
    let rows = within(group).getAllByTestId("session-row");
    expect(rows).toHaveLength(VISIBLE_SESSIONS);
    expect(at(rows, 0)).toHaveTextContent("sessions.thisDevice");

    const more = within(group).getByRole("button", {
      name: 'sessions.showMore {"count":3}',
    });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);

    rows = within(group).getAllByTestId("session-row");
    expect(rows).toHaveLength(8);
    const fewer = within(group).getByRole("button", {
      name: "sessions.showFewer",
    });
    expect(fewer).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(fewer);
    expect(within(group).getAllByTestId("session-row")).toHaveLength(
      VISIBLE_SESSIONS,
    );
  });

  it("does not fold a group that fits", () => {
    renderPanel();

    expect(screen.queryByRole("button", { name: /sessions\.show/ })).toBeNull();
  });

  it("folds the dialog's list, and signs out every other session", async () => {
    mocks.sessions.data = manyAdminSessions();
    mocks.post.mockResolvedValue({ data: { revoked: 7 } });
    renderPanel({ user: "admin" });

    expect(screen.getAllByTestId("session-row")).toHaveLength(VISIBLE_SESSIONS);
    expect(
      screen.getByRole("button", { name: 'sessions.showMore {"count":3}' }),
    ).toBeInTheDocument();

    // the action is reachable without unfolding, and counts the folded rows
    fireEvent.click(
      screen.getByRole("button", { name: "sessions.signOutOthers" }),
    );
    expect(screen.getByTestId("confirm-clear-dialog")).toHaveTextContent(
      'sessions.othersDescription {"count":7}',
    );
    confirm();

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        'sessions.signedOut {"count":7}',
      ),
    );
  });

  it("reports in the panel instead of a toast when asked", async () => {
    mocks.post.mockRejectedValueOnce(new Error("offline"));
    renderPanel({ user: "admin", inlineFeedback: true });
    const signOutOthers = () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.signOutOthers" }),
      );
      confirm();
    };

    signOutOthers();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "sessions.signOutFailed",
      ),
    );

    // trying again clears the failure and reports the success
    signOutOthers();
    await waitFor(() =>
      expect(screen.getByTestId("sessions-feedback")).toHaveTextContent(
        'sessions.signedOut {"count":1}',
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("explains once that every session comes through one proxy", () => {
    mocks.sessions.data = SESSIONS.map((row) => ({ ...row, ip: "172.22.0.1" }));
    renderPanel();

    const hint = screen.getByTestId("sessions-proxy-hint");
    expect(hint).toHaveTextContent('sessions.proxyHint {"ip":"172.22.0.1"}');
    expect(within(hint).getByRole("link")).toHaveAttribute(
      "href",
      expect.stringContaining("authentication#login-failure-rate-limiting"),
    );
    // the rows name the address as where they came from, in the normal font
    const rows = screen.getAllByTestId("session-row");
    for (const row of rows) {
      expect(row).toHaveTextContent('sessions.from {"ip":"172.22.0.1"}');
    }
    expect(at(rows, 0).querySelector(".font-mono")).toBeNull();
  });

  it("shows device addresses as they are when they differ", () => {
    mocks.sessions.data = SESSIONS.map((row, index) => ({
      ...row,
      ip: `192.168.1.${20 + index}`,
    }));
    renderPanel();

    expect(screen.queryByTestId("sessions-proxy-hint")).toBeNull();
    const first = at(screen.getAllByTestId("session-row"), 0);
    expect(first.querySelector(".font-mono")).toHaveTextContent("192.168.1.20");
  });

  it("leaves the proxy hint out of the account dialog and public addresses", () => {
    mocks.sessions.data = SESSIONS.map((row) => ({ ...row, ip: "172.22.0.1" }));
    const { unmount } = renderPanel({ user: "admin" });
    expect(screen.queryByTestId("sessions-proxy-hint")).toBeNull();
    unmount();

    mocks.sessions.data = SESSIONS.map((row) => ({
      ...row,
      ip: "203.0.113.9",
    }));
    renderPanel();
    expect(screen.queryByTestId("sessions-proxy-hint")).toBeNull();
  });
});
