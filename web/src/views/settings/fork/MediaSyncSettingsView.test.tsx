import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MediaSyncSettingsView from "../MediaSyncSettingsView";

const h = vi.hoisted(() => ({
  post: vi.fn<(url: string, body: unknown) => Promise<unknown>>(),
  toastSuccess: vi.fn<(message: string) => void>(),
  toastError: vi.fn<(message: string) => void>(),
  job: undefined as unknown,
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    default: {
      post: (url: string, body: unknown) => h.post(url, body),
      isAxiosError: actual.default.isAxiosError,
    },
  };
});
vi.mock("sonner", () => ({
  toast: {
    success: (message: string) => h.toastSuccess(message),
    error: (message: string) => h.toastError(message),
  },
}));
vi.mock("@/api/ws", () => ({
  useJobStatus: () => ({ payload: h.job }),
}));
vi.mock("@/hooks/use-doc-domain", () => ({
  useDocDomain: () => ({ getLocaleDocUrl: (path: string) => path }),
}));

function axiosError(status: number) {
  return Object.assign(new Error(`status ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

function start() {
  render(
    <MemoryRouter>
      <MediaSyncSettingsView />
    </MemoryRouter>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /mediaSync.startDryRun/ }),
  );
}

describe("MediaSyncSettingsView (fork UI155)", () => {
  beforeEach(() => {
    h.post.mockReset();
    h.toastSuccess.mockReset();
    h.toastError.mockReset();
    h.job = undefined;
  });

  it("says a sync is already running when the server answers 409", async () => {
    h.post.mockRejectedValue(axiosError(409));
    start();
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(
        "maintenance.sync.alreadyRunning",
      ),
    );
    expect(h.toastError).not.toHaveBeenCalledWith("maintenance.sync.error");
  });

  it("reports any other failure as an error", async () => {
    h.post.mockRejectedValue(axiosError(500));
    start();
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith("maintenance.sync.error"),
    );
  });

  it("confirms a queued sync", async () => {
    h.post.mockResolvedValue({ status: 202 });
    start();
    await waitFor(() =>
      expect(h.toastSuccess).toHaveBeenCalledWith("maintenance.sync.started"),
    );
  });

  it.each([
    [true, "maintenance.sync.resultsFields.spaceToReclaim"],
    [false, "maintenance.sync.resultsFields.spaceReclaimed"],
  ])("shows the space a finished sync freed (dry run %s)", (dryRun, label) => {
    const stats = {
      files_checked: 4,
      orphans_found: 2,
      orphans_deleted: dryRun ? 0 : 2,
      bytes_reclaimed: 1536,
      aborted: false,
      error: null,
    };
    h.job = {
      id: "job1",
      job_type: "media_sync",
      status: "success",
      dry_run: dryRun,
      results: {
        previews: stats,
        totals: {
          files_checked: 4,
          orphans_found: 2,
          orphans_deleted: stats.orphans_deleted,
          bytes_reclaimed: 3 * 1048576,
        },
      },
    };
    render(
      <MemoryRouter>
        <MediaSyncSettingsView />
      </MemoryRouter>,
    );

    expect(screen.getAllByText(label)).toHaveLength(2);
    expect(screen.getByText("1.50 KiB")).toBeTruthy();
    expect(screen.getByText("3.00 MiB")).toBeTruthy();
  });
});
