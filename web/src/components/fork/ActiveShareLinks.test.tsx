import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "@/context/auth-state";
import type { components } from "@/types/fork/api.gen";
import ActiveShareLinks from "./ActiveShareLinks";

type ShareLink = components["schemas"]["ShareLinkListItem"];

const useApi = vi.fn<(...args: unknown[]) => unknown>();
const axiosDelete = vi.fn<(url: string) => Promise<unknown>>();
const toastSuccess = vi.fn<(message: string) => void>();
const toastError = vi.fn<(message: string) => void>();

vi.mock("@/api/fork/client", () => ({
  useApi: (...args: unknown[]) => useApi(...args),
}));
vi.mock("axios", () => ({
  default: { delete: (url: string) => axiosDelete(url) },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (message: string) => toastSuccess(message),
    error: (message: string) => toastError(message),
  },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

function link(overrides: Partial<ShareLink> = {}): ShareLink {
  return {
    token: "tokenAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    url: "/share/tokenAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    event_id: "event-1",
    camera: "front_door",
    created_by: "bob",
    created_at: Date.now() / 1000 - 60,
    expires_at: Date.now() / 1000 + 3 * 3600 + 30,
    ...overrides,
  };
}

function renderList(
  props: Parameters<typeof ActiveShareLinks>[0] = {},
  username = "bob",
) {
  return render(
    <AuthContext.Provider
      value={{
        auth: {
          user: { username, role: "viewer" },
          allowedCameras: [],
          isLoading: false,
          isAuthenticated: true,
        },
        login: vi.fn(),
        logout: vi.fn(),
      }}
    >
      <ActiveShareLinks {...props} />
    </AuthContext.Provider>,
  );
}

describe("ActiveShareLinks", () => {
  const mutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mutate.mockResolvedValue(undefined);
  });

  it("reads the typed list endpoint", () => {
    useApi.mockReturnValue({ data: [], isLoading: false, mutate });
    renderList();

    expect(useApi).toHaveBeenCalledWith("/fork/share", expect.any(Object));
    expect(screen.getByText("clipShare.activeEmpty")).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    useApi.mockReturnValue({ data: undefined, isLoading: true, mutate });
    renderList();

    expect(screen.getByRole("status")).toHaveTextContent(
      "clipShare.activeLoading",
    );
  });

  it("shows an error state that can retry", () => {
    useApi.mockReturnValue({
      data: undefined,
      error: new Error("offline"),
      isLoading: false,
      mutate,
    });
    renderList();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "clipShare.activeFailed",
    );
    fireEvent.click(screen.getByRole("button", { name: "clipShare.retry" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("lists each link with its expiry and marks the dialog's own link", () => {
    useApi.mockReturnValue({
      data: [
        link(),
        link({
          token: "tokenBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          event_id: "event-2",
          created_by: "eve",
          expires_at: Date.now() / 1000 + 3 * 86400 + 30,
        }),
      ],
      isLoading: false,
      mutate,
    });
    renderList({ currentToken: "tokenAAAAAAAAAAAAAAAAAAAAAAAAAAA" });

    const rows = screen.getAllByTestId("share-clip-active-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('clipShare.expiresIn.hours {"count":3}');
    expect(rows[0]).toHaveTextContent("clipShare.thisLink");
    expect(rows[0]).not.toHaveTextContent("clipShare.createdBy");
    expect(rows[1]).toHaveTextContent('clipShare.expiresIn.days {"count":3}');
    expect(rows[1]).not.toHaveTextContent("clipShare.thisLink");
    // someone else's link (an admin's view) names its creator
    expect(rows[1]).toHaveTextContent('clipShare.createdBy {"user":"eve"}');
  });

  it("revokes a link, drops it from the list and tells the dialog", async () => {
    const onRevoked = vi.fn();
    axiosDelete.mockResolvedValue({ data: { success: true } });
    useApi.mockReturnValue({ data: [link()], isLoading: false, mutate });
    renderList({ onRevoked });

    fireEvent.click(screen.getByRole("button", { name: /revokeLabel/ }));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(axiosDelete).toHaveBeenCalledWith(
      "fork/share/tokenAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(onRevoked).toHaveBeenCalledWith("tokenAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(toastSuccess).toHaveBeenCalledWith("clipShare.revoked");
    const [update, options] = mutate.mock.calls[0] as [
      (links: ShareLink[]) => ShareLink[],
      unknown,
    ];
    expect(update([link()])).toEqual([]);
    expect(options).toEqual({ revalidate: true });
  });

  it("keeps the link and reports the failure when revoking fails", async () => {
    const onRevoked = vi.fn();
    axiosDelete.mockRejectedValue(new Error("offline"));
    useApi.mockReturnValue({ data: [link()], isLoading: false, mutate });
    renderList({ onRevoked });

    fireEvent.click(screen.getByRole("button", { name: /revokeLabel/ }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("clipShare.revokeFailed"),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(onRevoked).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /revokeLabel/ }),
    ).not.toBeDisabled();
  });
});
